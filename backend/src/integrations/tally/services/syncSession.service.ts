import { v4 as uuidv4 } from "uuid";
import db from "../../../db/index.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.service.js";
import { markSync } from "./connector.service.js";
import { recordCheckpoint } from "./checkpoint.service.js";
import type { SyncType, EntityType } from "../constants.js";

export interface SyncSessionRow {
  id: string;
  sync_id: string;
  connector_id: string;
  user_id: string;
  company_id: string;
  tally_company_id: string | null;
  sync_type: SyncType;
  entity_type: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED";
  started_at: string;
  completed_at: string | null;
  total_records: number;
  processed_records: number;
  successful_records: number;
  duplicate_records: number;
  failed_records: number;
  total_batches: number;
  processed_batches: number;
  error_message: string | null;
}

const ACTIVE_STATUSES: SyncSessionRow["status"][] = ["PENDING", "RUNNING"];

export function getSessionBySyncId(syncId: string): SyncSessionRow | undefined {
  return db
    .prepare(`SELECT * FROM tally_sync_sessions WHERE sync_id = ?`)
    .get(syncId) as SyncSessionRow | undefined;
}

/** Get a session and enforce tenant ownership. */
export function requireSessionForConnector(
  syncId: string,
  connectorRowId: string,
  userId: string
): SyncSessionRow {
  const session = getSessionBySyncId(syncId);
  if (!session) {
    throw new ApiError("INVALID_PAYLOAD", "Unknown syncId");
  }
  if (session.connector_id !== connectorRowId || session.user_id !== userId) {
    throw new ApiError("AUTHORIZATION_FAILED", "Session does not belong to this connector");
  }
  return session;
}

/**
 * Start a sync session. Prevents unbounded concurrent sessions per
 * connector + company + entity type (an active session blocks re-start).
 */
export function startSession(params: {
  connectorRowId: string;
  userId: string;
  companyId: string;
  tallyCompanyId: string | null;
  syncType: SyncType;
  entityType: string;
  totalBatches?: number;
  requestId?: string;
}): { syncId: string; session: SyncSessionRow } {
  const active = db
    .prepare(
      `SELECT sync_id FROM tally_sync_sessions
       WHERE connector_id = ? AND company_id = ? AND entity_type = ? AND status IN ('PENDING','RUNNING')
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(params.connectorRowId, params.companyId, params.entityType) as
    | { sync_id: string }
    | undefined;

  if (active) {
    throw new ApiError("INVALID_BATCH", `A ${params.entityType} sync is already running`, {
      activeSyncId: active.sync_id,
    });
  }

  const syncId = `sync_${uuidv4().replace(/-/g, "").slice(0, 20)}`;
  const id = uuidv4();

  db.prepare(
    `INSERT INTO tally_sync_sessions
       (id, sync_id, connector_id, user_id, company_id, tally_company_id, sync_type, entity_type, status, total_batches)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?)`
  ).run(
    id,
    syncId,
    params.connectorRowId,
    params.userId,
    params.companyId,
    params.tallyCompanyId,
    params.syncType,
    params.entityType,
    params.totalBatches ?? 0
  );

  audit("SYNC_STARTED", {
    userId: params.userId,
    connectorId: undefined,
    syncId,
    requestId: params.requestId,
    detail: { entityType: params.entityType, syncType: params.syncType, companyId: params.companyId },
  });

  const session = getSessionBySyncId(syncId)!;
  return { syncId, session };
}

/** Set declared totals from sync/start (optional but recommended). */
export function declareSessionTotals(syncRowId: string, totalRecords: number, totalBatches: number): void {
  db.prepare(
    `UPDATE tally_sync_sessions SET total_records = MAX(total_records, ?), total_batches = MAX(total_batches, ?)
     WHERE id = ?`
  ).run(totalRecords, totalBatches, syncRowId);
}

/** Apply a processed batch's counters to the session. */
export function applyBatchCounters(
  syncRowId: string,
  counters: { accepted: number; duplicates: number; failed: number }
): void {
  db.prepare(
    `UPDATE tally_sync_sessions
     SET processed_records = processed_records + ?,
         successful_records = successful_records + ?,
         duplicate_records = duplicate_records + ?,
         failed_records = failed_records + ?,
         processed_batches = processed_batches + 1,
         status = 'RUNNING'
     WHERE id = ?`
  ).run(
    counters.accepted + counters.duplicates + counters.failed,
    counters.accepted,
    counters.duplicates,
    counters.failed,
    syncRowId
  );
}

/** Reject a batch (validation failure) — counts as processed but failed. */
export function applyBatchRejection(syncRowId: string, failedCount: number): void {
  db.prepare(
    `UPDATE tally_sync_sessions
     SET processed_records = processed_records + ?, failed_records = failed_records + ?,
         processed_batches = processed_batches + 1, status = 'RUNNING'
     WHERE id = ?`
  ).run(failedCount, failedCount, syncRowId);
}

/**
 * Complete a session. Status derives from counters: COMPLETED when nothing
 * failed, PARTIAL when some records failed, plus checkpoint persistence.
 */
export function completeSession(params: {
  session: SyncSessionRow;
  requestId?: string;
  lastObjectId?: string | null;
  lastVoucherDate?: string | null;
  lastVoucherNumber?: string | null;
}): SyncSessionRow {
  const s = params.session;
  const failed = s.failed_records;
  const status: SyncSessionRow["status"] =
    failed === 0 ? "COMPLETED" : failed < s.processed_records ? "PARTIAL" : "FAILED";

  db.prepare(
    `UPDATE tally_sync_sessions
     SET status = ?, completed_at = datetime('now')
     WHERE id = ?`
  ).run(status, s.id);

  // Persist incremental checkpoint for this company + entity type
  recordCheckpoint({
    userId: s.user_id,
    companyId: s.company_id,
    entityType: s.entity_type,
    lastObjectId: params.lastObjectId ?? null,
    lastVoucherDate: params.lastVoucherDate ?? null,
    lastVoucherNumber: params.lastVoucherNumber ?? null,
  });

  markSync(s.connector_id, status === "COMPLETED");

  const event =
    status === "COMPLETED" ? "SYNC_COMPLETED" : status === "PARTIAL" ? "SYNC_PARTIAL" : "SYNC_FAILED";
  audit(event, {
    userId: s.user_id,
    syncId: s.sync_id,
    requestId: params.requestId,
    detail: {
      entityType: s.entity_type,
      processed: s.processed_records,
      successful: s.successful_records,
      duplicates: s.duplicate_records,
      failed: s.failed_records,
    },
  });

  return getSessionBySyncId(s.sync_id)!;
}

/** Mark a session failed with an error message (from sync/error). */
export function failSession(session: SyncSessionRow, errorMessage: string, requestId?: string): SyncSessionRow {
  if (!ACTIVE_STATUSES.includes(session.status)) {
    // Idempotent: already-final sessions stay final
    return session;
  }
  db.prepare(
    `UPDATE tally_sync_sessions
     SET status = 'FAILED', completed_at = datetime('now'), error_message = ?
     WHERE id = ?`
  ).run(errorMessage.slice(0, 2000), session.id);

  markSync(session.connector_id, false);

  audit("SYNC_FAILED", {
    userId: session.user_id,
    syncId: session.sync_id,
    requestId,
    detail: { entityType: session.entity_type },
  });

  return getSessionBySyncId(session.sync_id)!;
}

/** Cancel all active sessions for a connector (used on disconnect). */
export function cancelActiveSessionsForConnector(connectorRowId: string): void {
  db.prepare(
    `UPDATE tally_sync_sessions
     SET status = 'CANCELLED', completed_at = datetime('now'),
         error_message = COALESCE(error_message, 'Connector disconnected')
     WHERE connector_id = ? AND status IN ('PENDING','RUNNING')`
  ).run(connectorRowId);
}
