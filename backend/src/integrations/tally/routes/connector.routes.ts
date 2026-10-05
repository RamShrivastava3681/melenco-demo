import { Router, Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { requireConnectorAuth } from "../middleware/connectorAuth.js";
import { rateLimiters } from "../middleware/rateLimiter.js";
import { sendError, errorHandler } from "../errors.js";
import { formatZodError } from "../validators/schemas.js";
import { consumePairingCode } from "../services/pairing.service.js";
import { registerConnector } from "../services/connector.service.js";
import { ensureCompany } from "../services/company.service.js";
import { startSession, requireSessionForConnector, completeSession, failSession } from "../services/syncSession.service.js";
import { processBatch } from "../services/batch.service.js";
import { buildConnectorConfig } from "../services/config.service.js";
import { audit } from "../services/audit.service.js";
import { logInfo, logError } from "../utils/logger.js";

const router = Router();

function parseBody(schema: z.ZodTypeAny, body: unknown): any {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new ApiError("INVALID_PAYLOAD", "Payload validation failed", formatZodError(result.error));
  }
  return result.data;
}

/**
 * POST /connect — exchange a pairing code for permanent connector credentials.
 * Public (no connector auth yet) but rate-limited per IP.
 * Requires the pairing code to belong to the JWT-authenticated tenant context
 * carried in the pairing record itself — the code IS the transient credential.
 */
router.post("/connect", rateLimiters.connect, (req: Request, res: Response) => {
  const requestId = req.requestId;
  try {
    const input = parseBody(connectSchema, req.body);

    // 1. Validate + consume pairing code (single-use, TTL-checked).
    //    The pairing record carries the tenant (user_id) — that is the
    //    authorization anchor: the connector inherits exactly that tenant.
    const pairing = peekCode(input.pairingCode);
    const credentials = registerConnector({
      userId: pairing.user_id,
      pairingCodeId: pairing.id,
      connectorName: input.connectorName,
      deviceName: input.deviceName,
      deviceId: input.deviceId,
      appVersion: input.appVersion,
      requestId,
    });
    consumePairingCode(input.pairingCode, pairing.user_id, requestId);

    // 2. Register companies reported by the connector (maps tally companies)
    const companies = (input.companies || []).map((c: { guid: string; name: string }) =>
      ensureCompany({
        userId: pairing.user_id,
        tallyCompanyGuid: c.guid,
        tallyCompanyName: c.name,
        requestId,
      })
    );

    logInfo("connect", req, `Connector ${credentials.credentials.connectorId} paired`);

    res.status(201).json({
      success: true,
      connectorId: credentials.credentials.connectorId,
      accessToken: credentials.credentials.accessToken, // shown exactly once
      hmacSecret: credentials.credentials.hmacSecret, // shown exactly once
      config: buildConnectorConfig(pairing.user_id, companies[0]?.id ?? null),
      companies: companies.map((c: any) => ({ id: c.id, tallyCompanyGuid: c.tally_company_guid, name: c.tally_company_name })),
      apiBaseUrl: credentials.credentials.apiBaseUrl,
      heartbeatIntervalSeconds: credentials.credentials.heartbeatIntervalSeconds,
    });
  } catch (err) {
    logError("connect", req, "Connect failed", err);
    errorHandler(err, req, res);
  }
});

// helper import placed after to avoid circular import noise
import { peekPairingCode as peekCode } from "../services/pairing.service.js";
import { connectSchema } from "../validators/schemas.js";

/**
 * Everything below requires connector authentication.
 * Scoped to connector paths only — /connect stays public.
 */
router.use("/heartbeat", requireConnectorAuth, rateLimiters.default);
router.use("/config", requireConnectorAuth, rateLimiters.default);
router.use("/sync", requireConnectorAuth, rateLimiters.default);

/**
 * POST /heartbeat — liveness + pending command pickup.
 */
router.post("/heartbeat", rateLimiters.heartbeat, (req: Request, res: Response) => {
  try {
    const input = parseBody(heartbeatSchema, req.body);
    const connector = req.connector!;

    // Deliver any pending cloud→connector commands (FIFO, mark delivered)
    const commands = db_allPendingCommands(connector.rowId);

    res.json({
      success: true,
      serverTime: new Date().toISOString(),
      heartbeatIntervalSeconds: 120,
      commands,
      configVersion: null,
    });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * GET /config — full sync configuration for this tenant (+ optional company).
 */
router.get("/config", (req: Request, res: Response) => {
  try {
    const connector = req.connector!;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : null;
    // Authorization: company must belong to the connector's tenant
    if (companyId) {
      const row = db_getCompany(connector.userId, companyId);
      if (!row) {
        return sendError(res, "INVALID_COMPANY", "Company not found for this account", undefined, req.requestId);
      }
    }
    res.json({ success: true, config: buildConnectorConfig(connector.userId, companyId) });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * POST /sync/start — open a sync session.
 */
router.post("/sync/start", (req: Request, res: Response) => {
  try {
    const input = parseBody(syncStartSchema, req.body);
    const connector = req.connector!;

    // Company must belong to this tenant — never trust client-supplied ids
    const company = db_getCompany(connector.userId, input.companyId);
    if (!company) {
      return sendError(res, "INVALID_COMPANY", "Company not found for this account", undefined, req.requestId);
    }

    const { syncId } = startSession({
      connectorRowId: connector.rowId,
      userId: connector.userId,
      companyId: company.id,
      tallyCompanyId: company.tally_company_guid,
      syncType: input.syncType,
      entityType: input.entityType,
      totalBatches: input.totalBatches,
      requestId: req.requestId,
    });

    if (input.totalRecords || input.totalBatches) {
      declareTotals(startedSessionRowId(syncId), input.totalRecords ?? 0, input.totalBatches ?? 0);
    }

    res.status(201).json({
      success: true,
      syncId,
      batchSize: buildConnectorConfig(connector.userId, company.id).batchLimits.maxRecords,
      nextBatch: 1,
    });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * POST /sync/batch — upload a batch of records, get a deterministic ACK.
 */
router.post("/sync/batch", rateLimiters.batch, (req: Request, res: Response) => {
  try {
    const input = parseBody(batchSchema, req.body);
    const connector = req.connector!;

    // Enforce payload byte cap (records serialized size)
    const bytes = Buffer.byteLength(JSON.stringify(input.records), "utf8");
    if (bytes > buildConnectorLimits().maxBytes) {
      return sendError(
        res,
        "INVALID_PAYLOAD",
        `Batch payload exceeds ${buildConnectorLimits().maxBytes} bytes`,
        { actualBytes: bytes },
        req.requestId
      );
    }

    const ack = processBatch(connector, input, req.requestId);
    res.json(ack);
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * POST /sync/complete — finalize a session and persist checkpoints.
 */
router.post("/sync/complete", (req: Request, res: Response) => {
  try {
    const input = parseBody(syncCompleteSchema, req.body);
    const connector = req.connector!;
    const session = requireSessionForConnector(input.syncId, connector.rowId, connector.userId);

    if (session.status === "COMPLETED" || session.status === "PARTIAL") {
      // Idempotent replay — return current state without side effects
      res.json({ success: true, session: publicSession(session) });
      return;
    }

    const updated = completeSession({
      session,
      requestId: req.requestId,
      lastObjectId: input.lastObjectId ?? null,
      lastVoucherDate: input.lastVoucherDate ?? null,
      lastVoucherNumber: input.lastVoucherNumber ?? null,
    });

    res.json({ success: true, session: publicSession(updated) });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * POST /sync/error — connector reports a fatal sync error.
 */
router.post("/sync/error", (req: Request, res: Response) => {
  try {
    const input = parseBody(syncErrorSchema, req.body);
    const connector = req.connector!;
    const session = requireSessionForConnector(input.syncId, connector.rowId, connector.userId);

    const updated = failSession(session, input.errorMessage, req.requestId);
    res.json({ success: true, session: publicSession(updated) });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

// ---- small db helpers (keep route bodies readable) -------------------------

import db from "../../../db/index.js";
import { heartbeatSchema, syncStartSchema, batchSchema, syncCompleteSchema, syncErrorSchema } from "../validators/schemas.js";
import { declareSessionTotals as declareTotals, getSessionBySyncId } from "../services/syncSession.service.js";
import { config } from "../utils/env.js";

function db_getCompany(userId: string, companyRowId: string): any {
  return db
    .prepare(`SELECT * FROM tally_companies WHERE id = ? AND user_id = ?`)
    .get(companyRowId, userId);
}

function db_allPendingCommands(connectorRowId: string): Array<{ id: string; command: string; payload?: unknown }> {
  const rows = db
    .prepare(
      `SELECT id, command, payload FROM tally_sync_commands
       WHERE connector_id = ? AND status = 'PENDING' ORDER BY created_at LIMIT 20`
    )
    .all(connectorRowId) as Array<{ id: string; command: string; payload: string | null }>;
  if (rows.length === 0) return [];
  db.prepare(
    `UPDATE tally_sync_commands SET status = 'DELIVERED', delivered_at = datetime('now')
     WHERE id IN (${rows.map((r) => `'${r.id.replace(/'/g, "''")}'`).join(",")})`
  ).run();
  return rows.map((r) => ({ id: r.id, command: r.command, payload: r.payload ? JSON.parse(r.payload) : undefined }));
}

function startedSessionRowId(syncId: string): string {
  return getSessionBySyncId(syncId)!.id;
}

function buildConnectorLimits() {
  return { maxRecords: config.batchMaxRecords, maxBytes: config.batchMaxBytes };
}

function publicSession(s: any) {
  return {
    syncId: s.sync_id,
    status: s.status,
    entityType: s.entity_type,
    syncType: s.sync_type,
    startedAt: s.started_at,
    completedAt: s.completed_at,
    totalRecords: s.total_records,
    processedRecords: s.processed_records,
    successfulRecords: s.successful_records,
    duplicateRecords: s.duplicate_records,
    failedRecords: s.failed_records,
    totalBatches: s.total_batches,
    processedBatches: s.processed_batches,
    errorMessage: s.error_message,
  };
}

export default router;
