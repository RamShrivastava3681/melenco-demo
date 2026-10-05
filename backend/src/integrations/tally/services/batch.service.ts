import db from "../../../db/index.js";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { config } from "../utils/env.js";
import { sha256 } from "../utils/crypto.js";
import { logWarn } from "../utils/logger.js";
import { normalizeRecord, getNormalizedTargetTable } from "../normalizers/registry.js";
import { storeRawRecords } from "./rawStore.service.js";
import { audit } from "./audit.service.js";
import {
  requireSessionForConnector,
  applyBatchCounters,
  applyBatchRejection,
  getSessionBySyncId,
} from "./syncSession.service.js";
import { requireCompanyAccess } from "./company.service.js";
import type { AuthenticatedConnector } from "../middleware/connectorAuth.js";
import type { BatchInput } from "../normalizers/registry.js";

export interface BatchAck {
  success: true;
  syncId: string;
  batchNumber: number;
  accepted: number;
  duplicates: number;
  failed: number;
  nextBatch: number;
}

/**
 * Process an uploaded batch.
 *
 * Guarantees:
 *  - Tenant/company/connector/session validated before any write.
 *  - Duplicate batches (same syncId + batchNumber) replay the stored ACK
 *    without reprocessing — safe retries.
 *  - Duplicate records are detected by source identity
 *    (tenantId + companyId + source + entityType + sourceObjectId) and
 *    counted, never double-inserted.
 *  - Every record is persisted to the raw/staging layer first.
 */
export function processBatch(
  connector: AuthenticatedConnector,
  input: BatchInput,
  requestId?: string
): BatchAck {
  // --- Structural validation --------------------------------------------
  if (input.records.length > config.batchMaxRecords) {
    throw new ApiError("INVALID_PAYLOAD", `Batch exceeds maximum of ${config.batchMaxRecords} records`);
  }
  if (input.batchNumber > input.totalBatches) {
    throw new ApiError("INVALID_BATCH", "batchNumber cannot exceed totalBatches");
  }

  // --- Authorization: session must belong to this connector + tenant ------
  const session = requireSessionForConnector(input.syncId, connector.rowId, connector.userId);

  // --- Duplicate batch? Replay stored ACK --------------------------------
  // Checked before the status guard so retries of already-processed batches
  // remain safe even if the session has since been completed.
  const existingBatch = db
    .prepare(`SELECT ack_json, status FROM tally_batches WHERE sync_id = ? AND batch_number = ?`)
    .get(session.id, input.batchNumber) as { ack_json: string; status: string } | undefined;

  if (existingBatch) {
    const ack = JSON.parse(existingBatch.ack_json || "{}");
    audit("BATCH_REPLAYED", {
      userId: connector.userId,
      connectorId: connector.connectorId,
      syncId: session.sync_id,
      requestId,
      detail: { batchNumber: input.batchNumber },
    });
    return ack as BatchAck;
  }

  // New batches are only accepted into active sessions
  if (session.status !== "RUNNING" && session.status !== "PENDING") {
    throw new ApiError("INVALID_BATCH", `Sync session is ${session.status} — start a new sync`);
  }

  // Session's entity must match the batch declaration
  if (session.entity_type !== input.entityType) {
    throw new ApiError("INVALID_BATCH", "entityType does not match the sync session");
  }

  // Company must belong to this tenant
  const company = requireCompanyAccess(connector.userId, session.company_id);
  if (input.companyId && input.companyId !== company.id) {
    throw new ApiError("INVALID_COMPANY", "companyId does not match the sync session");
  }

  // --- Store raw payloads first (staging) --------------------------------
  storeRawRecords({
    userId: connector.userId,
    connectorRowId: connector.rowId,
    companyId: session.company_id,
    syncId: session.sync_id,
    entityType: input.entityType,
    records: input.records.map((r: any) => ({
      sourceObjectId: r.sourceObjectId ?? r.tallyGuid ?? null,
      payload: r,
    })),
  });

  // --- Per-record processing ---------------------------------------------
  let accepted = 0;
  let duplicates = 0;
  let failed = 0;

  const recordStmt = db.prepare(
    `SELECT id, content_hash, whizunik_table, whizunik_record_id FROM tally_source_records
     WHERE user_id = ? AND company_id = ? AND source = 'tally' AND entity_type = ? AND source_object_id = ?`
  );
  const insertSourceStmt = db.prepare(
    `INSERT INTO tally_source_records
       (id, user_id, company_id, source, entity_type, source_object_id, source_company_id,
        source_voucher_number, source_voucher_type, source_voucher_date, content_hash,
        whizunik_table, whizunik_record_id, sync_id)
     VALUES (?, ?, ?, 'tally', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateSourceStmt = db.prepare(
    `UPDATE tally_source_records
     SET content_hash = ?, whizunik_table = ?, whizunik_record_id = ?, last_seen_at = datetime('now'), sync_id = ?
     WHERE id = ?`
  );

  for (const raw of input.records) {
    try {
      // 1. Resolve source identity (GUID preferred, deterministic fallback)
      const sourceObjectId = resolveSourceObjectId(input.entityType, raw);

      // 2. Content hash for change detection
      const contentHash = sha256(JSON.stringify(raw.data ?? raw));

      // 3. Idempotency check
      const existing = recordStmt.get(
        connector.userId,
        session.company_id,
        input.entityType,
        sourceObjectId
      ) as { id: string; content_hash: string | null } | undefined;

      if (existing && existing.content_hash === contentHash) {
        // Identical retransmission — count as duplicate, no writes
        duplicates++;
        continue;
      }

      // 4. Normalize into WhizUnik records
      const result = normalizeRecord({
        userId: connector.userId,
        companyId: session.company_id,
        entityType: input.entityType,
        record: raw,
        sourceObjectId,
      });

      // 5. Record source identity (INSERT OR IGNORE guards concurrency)
      if (existing) {
        updateSourceStmt.run(
          contentHash,
          result.table,
          result.recordId,
          session.sync_id,
          existing.id
        );
        accepted++; // update of changed content
      } else {
        try {
          insertSourceStmt.run(
            uuidv4(),
            connector.userId,
            session.company_id,
            input.entityType,
            sourceObjectId,
            company.tally_company_guid,
            raw.voucherNumber ?? null,
            raw.voucherType ?? null,
            raw.voucherDate ?? null,
            contentHash,
            result.table,
            result.recordId,
            session.sync_id
          );
          accepted++;
        } catch (e: any) {
          const msg = String(e?.message || e);
          if (msg.includes("UNIQUE")) {
            duplicates++; // concurrent duplicate — safe
          } else {
            throw e;
          }
        }
      }
    } catch (err) {
      // Per-record failure: count it, log the reason (never the payload), continue
      const code = err instanceof ApiError ? err.code : "DATABASE_ERROR";
      const msg = err instanceof Error ? err.message : String(err);
      logWarn("batch", null, `Record failed (${code}): ${msg}`);
      failed++;
    }
  }

  const ack: BatchAck = {
    success: true,
    syncId: session.sync_id,
    batchNumber: input.batchNumber,
    accepted,
    duplicates,
    failed,
    nextBatch: input.batchNumber + 1,
  };

  // --- Persist batch + ACK (idempotency anchor) ---------------------------
  db.prepare(
    `INSERT INTO tally_batches (id, sync_id, batch_number, status, accepted, duplicates, failed, ack_json, request_id)
     VALUES (?, ?, ?, 'ACCEPTED', ?, ?, ?, ?, ?)`
  ).run(
    uuidv4(),
    session.id,
    input.batchNumber,
    accepted,
    duplicates,
    failed,
    JSON.stringify(ack),
    requestId ?? null
  );

  // --- Update session counters --------------------------------------------
  applyBatchCounters(session.id, { accepted, duplicates, failed });

  audit("BATCH_ACCEPTED", {
    userId: connector.userId,
    connectorId: connector.connectorId,
    syncId: session.sync_id,
    requestId,
    detail: { batchNumber: input.batchNumber, accepted, duplicates, failed },
  });

  return ack;
}

/** Deterministic source identity: GUID when present, else stable-field fallback. */
function resolveSourceObjectId(entityType: string, raw: any): string {
  const guid = raw.sourceObjectId || raw.tallyGuid;
  if (guid && typeof guid === "string" && guid.trim()) return guid.trim();

  // Vouchers: derive from stable fields
  if (entityType.endsWith("VOUCHER") || entityType === "DEBIT_NOTE" || entityType === "CREDIT_NOTE") {
    if (!raw.voucherType || !raw.voucherNumber || !raw.voucherDate) {
      throw new ApiError(
        "TALLY_DATA_INVALID",
        "Voucher without a source id must include voucherType, voucherNumber and voucherDate"
      );
    }
    return fallbackIdentity(entityType, raw.voucherType, raw.voucherNumber, raw.voucherDate, raw.partyName);
  }
  // Masters: name is the natural key
  const name = raw.partyName || raw.data?.name;
  if (name && typeof name === "string" && name.trim()) {
    return `NAME-${entityType}-${name.trim().toUpperCase()}`;
  }
  throw new ApiError("TALLY_DATA_INVALID", "Record has neither a source id nor a usable natural key");
}

function fallbackIdentity(...parts: (string | null | undefined)[]): string {
  const norm = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim().toUpperCase());
  return `FBA-${sha256(parts.map(norm).join("|"))}`;
}

/** Read a session by syncId (used by complete/error handlers). */
export function sessionBySyncId(syncId: string) {
  return getSessionBySyncId(syncId);
}
