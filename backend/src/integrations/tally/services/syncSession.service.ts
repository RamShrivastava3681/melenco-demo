import { v4 as uuidv4 } from "uuid";
import {
  getSessionBySyncId as getBySync,
  getActiveSession,
  createSession,
  updateSession,
  cancelActiveSessionsForConnector as cancelForConnector,
} from "../../../db/storesTally.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.service.js";
import { markSync } from "./connector.service.js";
import { recordCheckpoint } from "./checkpoint.service.js";
import type { SyncType, EntityType } from "../constants.js";
import type { DbItem } from "../../../db/dynamo.js";

export interface SyncSessionRow extends DbItem {
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

export async function getSessionBySyncId(syncId: string): Promise<SyncSessionRow | undefined> {
  return (await getBySync(syncId)) as SyncSessionRow | undefined;
}

/** Get a session and enforce tenant ownership. */
export async function requireSessionForConnector(
  syncId: string,
  connectorRowId: string,
  userId: string
): Promise<SyncSessionRow> {
  const session = await getSessionBySyncId(syncId);
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
export async function startSession(params: {
  connectorRowId: string;
  userId: string;
  companyId: string;
  tallyCompanyId: string | null;
  syncType: SyncType;
  entityType: string;
  totalBatches?: number;
  requestId?: string;
}): Promise<{ syncId: string; session: SyncSessionRow }> {
  const active = await getActiveSession(params.connectorRowId, params.companyId, params.entityType);

  if (active) {
    throw new ApiError("INVALID_BATCH", `A ${params.entityType} sync is already running`, {
      activeSyncId: active.sync_id as string,
    });
  }

  const syncId = `sync_${uuidv4().replace(/-/g, "").slice(0, 20)}`;
  const id = uuidv4();

  await createSession({
    id,
    sync_id: syncId,
    connector_id: params.connectorRowId,
    user_id: params.userId,
    company_id: params.companyId,
    tally_company_id: params.tallyCompanyId,
    sync_type: params.syncType,
    entity_type: params.entityType,
    total_batches: params.totalBatches ?? 0,
  });

  audit("SYNC_STARTED", {
    userId: params.userId,
    connectorId: undefined,
    syncId,
    requestId: params.requestId,
    detail: { entityType: params.entityType, syncType: params.syncType, companyId: params.companyId },
  });

  const session = (await getSessionBySyncId(syncId)) as SyncSessionRow;
  return { syncId, session };
}

/** Set declared totals from sync/start (optional but recommended). */
export async function declareSessionTotals(syncRow: SyncSessionRow, totalRecords: number, totalBatches: number): Promise<void> {
  await updateSession(syncRow, {
    total_records: Math.max(Number(syncRow.total_records || 0), totalRecords),
    total_batches: Math.max(Number(syncRow.total_batches || 0), totalBatches),
  });
}

/** Apply a processed batch's counters to the session. */
export async function applyBatchCounters(
  syncRow: SyncSessionRow,
  counters: { accepted: number; duplicates: number; failed: number }
): Promise<void> {
  const total = counters.accepted + counters.duplicates + counters.failed;
  await updateSession(syncRow, {
    processed_records: Number(syncRow.processed_records || 0) + total,
    successful_records: Number(syncRow.successful_records || 0) + counters.accepted,
    duplicate_records: Number(syncRow.duplicate_records || 0) + counters.duplicates,
    failed_records: Number(syncRow.failed_records || 0) + counters.failed,
    processed_batches: Number(syncRow.processed_batches || 0) + 1,
    status: "RUNNING",
  });
}

/** Reject a batch (validation failure) — counts as processed but failed. */
export async function applyBatchRejection(syncRow: SyncSessionRow, failedCount: number): Promise<void> {
  await updateSession(syncRow, {
    processed_records: Number(syncRow.processed_records || 0) + failedCount,
    failed_records: Number(syncRow.failed_records || 0) + failedCount,
    processed_batches: Number(syncRow.processed_batches || 0) + 1,
    status: "RUNNING",
  });
}

/**
 * Complete a session. Status derives from counters: COMPLETED when nothing
 * failed, PARTIAL when some records failed, plus checkpoint persistence.
 */
export async function completeSession(params: {
  session: SyncSessionRow;
  requestId?: string;
  lastObjectId?: string | null;
  lastVoucherDate?: string | null;
  lastVoucherNumber?: string | null;
}): Promise<SyncSessionRow> {
  const fresh = ((await getSessionBySyncId(params.session.sync_id)) || params.session) as SyncSessionRow;
  const failed = Number(fresh.failed_records || 0);
  const processed = Number(fresh.processed_records || 0);
  const status: SyncSessionRow["status"] =
    failed === 0 ? "COMPLETED" : failed < processed ? "PARTIAL" : "FAILED";

  await updateSession(fresh, { status, completed_at: new Date().toISOString() });

  // Persist incremental checkpoint for this company + entity type
  await recordCheckpoint({
    userId: fresh.user_id,
    companyId: fresh.company_id,
    entityType: fresh.entity_type,
    lastObjectId: params.lastObjectId ?? null,
    lastVoucherDate: params.lastVoucherDate ?? null,
    lastVoucherNumber: params.lastVoucherNumber ?? null,
  });

  await markSync(fresh.connector_id, status === "COMPLETED");

  const event =
    status === "COMPLETED" ? "SYNC_COMPLETED" : status === "PARTIAL" ? "SYNC_PARTIAL" : "SYNC_FAILED";
  audit(event, {
    userId: fresh.user_id,
    syncId: fresh.sync_id,
    requestId: params.requestId,
    detail: {
      entityType: fresh.entity_type,
      processed: fresh.processed_records,
      successful: fresh.successful_records,
      duplicates: fresh.duplicate_records,
      failed: fresh.failed_records,
    },
  });

  return (await getSessionBySyncId(fresh.sync_id)) as SyncSessionRow;
}

/** Mark a session failed with an error message (from sync/error). */
export async function failSession(session: SyncSessionRow, errorMessage: string, requestId?: string): Promise<SyncSessionRow> {
  if (!ACTIVE_STATUSES.includes(session.status)) {
    // Idempotent: already-final sessions stay final
    return session;
  }
  await updateSession(session, {
    status: "FAILED",
    completed_at: new Date().toISOString(),
    error_message: errorMessage.slice(0, 2000),
  });

  await markSync(session.connector_id, false);

  audit("SYNC_FAILED", {
    userId: session.user_id,
    syncId: session.sync_id,
    requestId,
    detail: { entityType: session.entity_type },
  });

  return (await getSessionBySyncId(session.sync_id)) as SyncSessionRow;
}

/** Cancel all active sessions for a connector (used on disconnect). */
export async function cancelActiveSessionsForConnector(connectorRowId: string): Promise<void> {
  await cancelForConnector(connectorRowId);
}
