import { Router, Request, Response } from "express";
import db from "../../../db/index.js";
import { requireAuth } from "../../../middleware/auth.js";
import { rateLimiters } from "../middleware/rateLimiter.js";
import { sendError, errorHandler } from "../errors.js";
import { createPairingCode } from "../services/pairing.service.js";
import { revokeConnector, listConnectorsForUser } from "../services/connector.service.js";
import { cancelActiveSessionsForConnector } from "../services/syncSession.service.js";
import { buildStatusPayload, listSyncHistory, listAuditEvents, toConnectorStatus } from "../services/status.service.js";
import { audit } from "../services/audit.service.js";
import { formatZodError, pairingCodeRequestSchema } from "../validators/schemas.js";
import { logInfo, logError } from "../utils/logger.js";
import { config } from "../utils/env.js";
import { publicApiBaseUrl } from "../whizunik/baseUrl.js";

const router = Router();

// NOTE: requireAuth is applied per-route (not via router.use) because this
// router is mounted ahead of the connector router; unscoped middleware would
// also intercept the public POST /connect handshake.

/**
 * POST /pairing-code — Settings → Integrations → Tally → Connect Tally.
 * Returns a single-use, short-lived code (WZK-XXXX-XXXX). Plaintext is shown
 * once; only the hash is stored.
 */
router.post("/pairing-code", requireAuth, rateLimiters.pairing, (req: Request, res: Response) => {
  try {
    const parsed = pairingCodeRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendError(res, "INVALID_PAYLOAD", "Invalid request", formatZodError(parsed.error), req.requestId);
    }
    const pairing = createPairingCode(req.user!.userId, req.requestId);
    logInfo("pairing", req, `Pairing code created for user ${req.user!.userId}`);
    res.status(201).json({
      success: true,
      code: pairing.code,
      expiresAt: pairing.expiresAt,
      expiresInMinutes: config.pairingCodeTtlMinutes,
    });
  } catch (err) {
    logError("pairing", req, "Pairing code creation failed", err);
    errorHandler(err, req, res);
  }
});

/**
 * GET /status — everything the frontend Integrations panel needs. No secrets.
 */
router.get("/status", requireAuth, (req: Request, res: Response) => {
  try {
    res.json({ success: true, apiBaseUrl: publicApiBaseUrl(), ...buildStatusPayload(req.user!.userId) });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * GET /connectors — connector list (frontend-safe shape).
 */
router.get("/connectors", requireAuth, (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      connectors: listConnectorsForUser(req.user!.userId).map(toConnectorStatus),
    });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * GET /sync-history — session history with optional filters.
 */
router.get("/sync-history", requireAuth, (req: Request, res: Response) => {
  try {
    const { connectorId, status, limit } = req.query as Record<string, string | undefined>;
    const sessions = listSyncHistory(req.user!.userId, {
      connectorId,
      status,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    res.json({ success: true, sessions });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * GET /audit — recent audit events for the activity feed.
 */
router.get("/audit", requireAuth, (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    res.json({ success: true, events: listAuditEvents(req.user!.userId, limit) });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * POST /disconnect — revoke a connector (by public connector id or row id).
 * Handles both connector generations:
 *  - legacy tc_* rows in tally_connectors (revoked via revokeConnector)
 *  - new-spec wz-connector-* rows in connectors (status → revoked,
 *    refresh hash cleared, pending pushes cancelled)
 * Active sessions are cancelled; the connector can no longer authenticate and
 * disappears from the device list.
 */
router.post("/disconnect", requireAuth, (req: Request, res: Response) => {
  try {
    const { connectorId } = req.body as { connectorId?: string };
    if (!connectorId || typeof connectorId !== "string") {
      return sendError(res, "INVALID_PAYLOAD", "connectorId is required", undefined, req.requestId);
    }

    // Resolve public id → row id within this tenant only (legacy table first)
    const row = listConnectorsForUser(req.user!.userId).find(
      (c) => c.connector_id === connectorId || c.id === connectorId
    );
    if (row) {
      revokeConnector(req.user!.userId, row.id, req.requestId);
      cancelActiveSessionsForConnector(row.id);
      audit("CONNECTOR_DISCONNECTED", {
        userId: req.user!.userId,
        connectorId: row.connector_id,
        requestId: req.requestId,
      });
      logInfo("disconnect", req, `Connector ${row.connector_id} revoked`);
      res.json({ success: true });
      return;
    }

    // New-spec (WhizUnik Cloud API) connector for this tenant?
    const wz = db.prepare(
      `SELECT id, connector_id, status FROM connectors WHERE tenant_id = ? AND (connector_id = ? OR id = ?)`
    ).get(req.user!.userId, connectorId, connectorId) as
      | { id: string; connector_id: string; status: string }
      | undefined;
    if (!wz) {
      return sendError(res, "AUTHORIZATION_FAILED", "Connector not found for this account", undefined, req.requestId);
    }
    db.prepare(
      `UPDATE connectors SET status = 'revoked', refresh_token_hash = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(wz.id);
    // Stale queued pushes for a dead device must not linger as PENDING.
    try {
      db.prepare(
        `UPDATE connector_commands SET status = 'CANCELLED', completed_at = datetime('now')
         WHERE connector_id = ? AND status IN ('PENDING', 'DELIVERED')`
      ).run(wz.connector_id);
    } catch { /* commands table always exists with the whizunik schema; ignore */ }
    try {
      audit("CONNECTOR_DISCONNECTED", {
        userId: req.user!.userId,
        connectorId: wz.connector_id,
        requestId: req.requestId,
      });
    } catch { /* audit must never break disconnect */ }
    logInfo("disconnect", req, `Connector ${wz.connector_id} revoked`);
    res.json({ success: true });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

export default router;
