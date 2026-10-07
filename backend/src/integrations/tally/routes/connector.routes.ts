import { Router, Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { requireConnectorAuth } from "../middleware/connectorAuth.js";
import { rateLimiters } from "../middleware/rateLimiter.js";
import { sendError, errorHandler } from "../errors.js";
import { formatZodError } from "../validators/schemas.js";
import { consumePairingCode, peekPairingCode as peekCode } from "../services/pairing.service.js";
import { registerConnector, touchHeartbeat, getConnectorByPublicId } from "../services/connector.service.js";
import { ensureCompany, requireCompanyAccess } from "../services/company.service.js";
import { startSession, requireSessionForConnector, completeSession, failSession, declareSessionTotals as declareTotals, getSessionBySyncId } from "../services/syncSession.service.js";
import { processBatch } from "../services/batch.service.js";
import { buildConnectorConfig } from "../services/config.service.js";
import { audit } from "../services/audit.service.js";
import { logInfo, logError } from "../utils/logger.js";
import { AuthManager } from "../auth/auth-manager.js";
import { getAccessToken, resetAccessTokenCache } from "../token-cache.js";
import { publicApiBaseUrl } from "../whizunik/baseUrl.js";
import { connectSchema } from "../validators/schemas.js";
import {
  getSyncCommandGlobal,
  updateSyncCommand,
  listPendingCommandsForConnector,
} from "../../../db/storesTally.js";
import { heartbeatSchema, syncStartSchema, batchSchema, syncCompleteSchema, syncErrorSchema, commandAckSchema } from "../validators/schemas.js";
import { config } from "../utils/env.js";

const router = Router();

let auth: AuthManager | undefined;

/**
 * Initialize the AuthManager with the connector's credentials.
 * Called once per connector session (e.g. from /connect response handler).
 */
function initAuth(): void {
  if (!auth) {
    auth = new AuthManager(publicApiBaseUrl());
  }
}

/**
 * Retry a batch that failed with AUTHENTICATION_FAILED or TOKEN_EXPIRED.
 * Refreshes the token and re-processes the same batch.
 */
async function retryBatchWithFreshToken(
  batchInput: any,
  connectorRowId: string,
  requestId: string
): Promise<any> {
  if (!auth) {
    throw new Error('Auth manager not initialized');
  }

  // Read current connector credentials from DB to refresh
  const connectorRow = await getConnectorByPublicId(connectorRowId) as {
    id: string;
    access_token: string | null;
    refresh_token_hash: string | null;
    device_id: string | null;
    connector_id: string | null;
  } | undefined;

  if (!connectorRow || !connectorRow.refresh_token_hash || !connectorRow.device_id) {
    throw new Error('Connector credentials not found');
  }

  try {
    // Refresh the access token using the refresh token
    const fresh = await auth.refreshAccessToken(
      connectorRow.refresh_token_hash,
      connectorRow.device_id,
      connectorRow.connector_id!
    );

    // Reset the cache with the fresh token
    resetAccessTokenCache();
    // Note: getAccessToken will be called by the pipeline to get the fresh token

    // Re-process the batch with the fresh token
    // We need to re-invoke processBatch - but first let's mark the old batch as needing retry
    // For now, just re-process by calling processBatch again
    // The batch service should use the fresh token from the cache

    // Clear any previous dead marking and retry
    // We'll re-process with the same input
    const processed = await processBatch(
      {} as any, // will need proper connector auth
      batchInput,
      requestId
    );
    return processed;
  } catch (refreshErr) {
    logError("retryBatch", null, `Token refresh failed: ${refreshErr}`);
    throw refreshErr;
  }
}

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
router.post("/connect", rateLimiters.connect, async (req: Request, res: Response) => {
  const requestId = req.requestId;
  try {
    const input = parseBody(connectSchema, req.body);

    // 1. Validate + consume pairing code (single-use, TTL-checked).
    //    The pairing record carries the tenant (user_id) — that is the
    //    authorization anchor: the connector inherits exactly that tenant.
    const pairing = await peekCode(input.pairingCode);
    const credentials = await registerConnector({
      userId: pairing.user_id,
      pairingCodeId: pairing.id,
      connectorName: input.connectorName,
      deviceName: input.deviceName,
      deviceId: input.deviceId,
      appVersion: input.appVersion,
      requestId,
    });
    await consumePairingCode(input.pairingCode, pairing.user_id, requestId);

    // 2. Register companies reported by the connector (maps tally companies)
    const companies: any[] = [];
    for (const c of input.companies || []) {
      companies.push(
        await ensureCompany({
          userId: pairing.user_id,
          tallyCompanyGuid: (c as { guid: string; name: string }).guid,
          tallyCompanyName: (c as { guid: string; name: string }).name,
          requestId,
        })
      );
    }

    logInfo("connect", req, `Connector ${credentials.credentials.connectorId} paired`);

    res.status(201).json({
      success: true,
      connectorId: credentials.credentials.connectorId,
      accessToken: credentials.credentials.accessToken, // shown exactly once
      hmacSecret: credentials.credentials.hmacSecret, // shown exactly once
      config: await buildConnectorConfig(pairing.user_id, companies[0]?.id ?? null),
      companies: companies.map((c: any) => ({ id: c.id, tallyCompanyGuid: c.tally_company_guid, name: c.tally_company_name })),
      apiBaseUrl: credentials.credentials.apiBaseUrl,
      heartbeatIntervalSeconds: credentials.credentials.heartbeatIntervalSeconds,
    });
  } catch (err) {
    logError("connect", req, "Connect failed", err);
    errorHandler(err, req, res);
  }
});

/**
 * Everything below requires connector authentication.
 * Scoped to connector paths only — /connect stays public.
 */
router.use("/heartbeat", requireConnectorAuth, rateLimiters.default);
router.use("/config", requireConnectorAuth, rateLimiters.default);
router.use("/sync", requireConnectorAuth, rateLimiters.default);
router.use("/commands", requireConnectorAuth, rateLimiters.default);

/**
 * POST /heartbeat — liveness + pending command pickup.
 */
router.post("/heartbeat", rateLimiters.heartbeat, async (req: Request, res: Response) => {
  try {
    const input = parseBody(heartbeatSchema, req.body);
    void input;
    const connector = req.connector!;

    // Record liveness so the platform Online badge + lastConnection stay fresh.
    await touchHeartbeat(connector.rowId);

    // Deliver any pending cloud→connector commands (FIFO, mark delivered)
    const commands = await db_allPendingCommands(connector.rowId);

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
 * POST /commands/ack — connector acknowledges a pushed command (e.g.
 * PUSH_VOUCHERS written to Tally). Marks DONE/CANCELLED so the platform UI
 * can show Queued → Delivered → Done.
 */
router.post("/commands/ack", async (req: Request, res: Response) => {
  try {
    const input = parseBody(commandAckSchema, req.body);
    const connector = req.connector!;
    const row = await getSyncCommandGlobal(input.commandId) as { id: string; connector_id: string; status: string } | undefined;
    if (!row || row.connector_id !== connector.rowId) {
      return sendError(res, "INVALID_PAYLOAD", "Unknown command for this connector", undefined, req.requestId);
    }
    await updateSyncCommand(row as any, { status: input.status, completed_at: new Date().toISOString() });
    audit("BATCH_ACCEPTED", {
      userId: connector.userId,
      connectorId: connector.connectorId,
      requestId: req.requestId,
      detail: { commandId: (row as any).id, status: input.status },
    });
    res.json({ success: true, id: (row as any).id, status: input.status });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * GET /config — full sync configuration for this tenant (+ optional company).
 */
router.get("/config", async (req: Request, res: Response) => {
  try {
    const connector = req.connector!;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : null;
    // Authorization: company must belong to the connector's tenant
    if (companyId) {
      try {
        await requireCompanyAccess(connector.userId, companyId);
      } catch {
        return sendError(res, "INVALID_COMPANY", "Company not found for this account", undefined, req.requestId);
      }
    }
    res.json({ success: true, config: await buildConnectorConfig(connector.userId, companyId) });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * POST /sync/start — open a sync session.
 */
router.post("/sync/start", async (req: Request, res: Response) => {
  try {
    const input = parseBody(syncStartSchema, req.body);
    const connector = req.connector!;

    // Company must belong to this tenant — never trust client-supplied ids
    let company: any;
    try {
      company = await requireCompanyAccess(connector.userId, input.companyId);
    } catch {
      return sendError(res, "INVALID_COMPANY", "Company not found for this account", undefined, req.requestId);
    }

    const { syncId } = await startSession({
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
      const row = await getSessionBySyncId(syncId);
      if (row) await declareTotals(row as any, input.totalRecords ?? 0, input.totalBatches ?? 0);
    }

    res.status(201).json({
      success: true,
      syncId,
      batchSize: (await buildConnectorConfig(connector.userId, company.id)).batchLimits.maxRecords,
      nextBatch: 1,
    });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * POST /sync/batch — upload a batch of records, get a deterministic ACK.
 * On AUTHENTICATION_FAILED or TOKEN_EXPIRED, refresh the token and retry once.
 */
router.post("/sync/batch", rateLimiters.batch, async (req: Request, res: Response) => {
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

    let ack: any;
    let retryCount = 0;
    let maxRetries = 1;

    // Retry loop for auth errors
    while (retryCount <= maxRetries) {
      try {
        ack = await processBatch(connector, input, req.requestId);
        // Success (or no auth error) - break out of retry loop
        break;
      } catch (processErr: any) {
        const errCode: string | undefined =
          processErr instanceof ApiError
            ? processErr.code
            : (processErr as Error & { code?: string })?.code;

        // If we got an authentication error, try to refresh the token and retry
        if ((errCode === "AUTHENTICATION_FAILED" || errCode === "TOKEN_EXPIRED") && retryCount < maxRetries) {
          retryCount++;
          logInfo("batchRetry", req, `Auth error (${errCode}), refreshing token and retrying batch`, {
            batchId: input.batchId,
            attempt: retryCount,
          });

          try {
            // Refresh the access token using the connector's refresh token
            if (!auth) {
              throw new Error('Auth manager not initialized');
            }

            const connectorRow = await getConnectorByPublicId(connector.connectorId) as {
              access_token: string | null;
              refresh_token_hash: string | null;
              device_id: string | null;
              connector_id: string | null;
            } | undefined;

            if (!connectorRow || !connectorRow.refresh_token_hash || !connectorRow.device_id) {
              throw new Error('Connector credentials not found for token refresh');
            }

            const fresh = await auth.refreshAccessToken(
              connectorRow.refresh_token_hash,
              connectorRow.device_id,
              connectorRow.connector_id!
            );

            // Reset the token cache with the fresh token
            resetAccessTokenCache();

            // Update the cached token used by the engine
            // (cachedAccessToken will be refreshed on next getAccessToken call)
            // For now, we just note the refresh and retry the same batch
            // The processBatch call below will use the fresh token via the cache
            logInfo("batchRetryRefreshed", req, `Token refreshed successfully`, {
              batchId: input.batchId,
              newExpiresAt: fresh.accessTokenExpiresAt,
            });

            // Continue the while loop to retry the batch with fresh token
            continue;
          } catch (refreshErr: any) {
            logError("batchRetryRefreshFailed", req, `Token refresh failed`, {
              error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
              batchId: input.batchId,
            });
            // If refresh fails, re-throw the original process error
            throw processErr;
          }
        } else {
          // Not an auth error, or max retries exceeded - throw the error
          throw processErr;
        }
      }
    }

    res.json(ack);
  } catch (err) {
    errorHandler(err, req, res);
  }
});

/**
 * POST /sync/complete — finalize a session and persist checkpoints.
 */
router.post("/sync/complete", async (req: Request, res: Response) => {
  try {
    const input = parseBody(syncCompleteSchema, req.body);
    const connector = req.connector!;
    const session = await requireSessionForConnector(input.syncId, connector.rowId, connector.userId);

    if (session.status === "COMPLETED" || session.status === "PARTIAL") {
      // Idempotent replay — return current state without side effects
      res.json({ success: true, session: publicSession(session) });
      return;
    }

    const updated = await completeSession({
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
router.post("/sync/error", async (req: Request, res: Response) => {
  try {
    const input = parseBody(syncErrorSchema, req.body);
    const connector = req.connector!;
    const session = await requireSessionForConnector(input.syncId, connector.rowId, connector.userId);

    const updated = await failSession(session, input.errorMessage, req.requestId);
    res.json({ success: true, session: publicSession(updated) });
  } catch (err) {
    errorHandler(err, req, res);
  }
});

// ---- small db helpers (keep route bodies readable) -------------------------

async function db_allPendingCommands(connectorRowId: string): Promise<Array<{ id: string; command: string; payload?: unknown }>> {
  const rows = await listPendingCommandsForConnector(connectorRowId, 20);
  if (rows.length === 0) return [];
  const now = new Date().toISOString();
  for (const r of rows) {
    await updateSyncCommand(r, { status: "DELIVERED", delivered_at: now });
  }
  return rows.map((r) => ({ id: r.id as string, command: r.command as string, payload: r.payload ? JSON.parse(r.payload as string) : undefined }));
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
