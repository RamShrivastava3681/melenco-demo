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
import { getBatch, createBatch, getSourceRecord, putSourceRecord } from "../../../db/storesTally.js";
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
export async function processBatch(
  connector: AuthenticatedConnector,
  input: BatchInput,
  requestId?: string
): Promise<BatchAck> {
  // --- Structural validation --------------------------------------------
  if (input.records.length > config.batchMaxRecords) {
    throw new ApiError("INVALID_PAYLOAD", `Batch exceeds maximum of ${config.batchMaxRecords} records`);
  }
  if (input.batchNumber > input.totalBatches) {
    throw new ApiError("INVALID_BATCH", "batchNumber cannot exceed totalBatches");
  }

  // --- Authorization: session must belong to this connector + tenant ------
  const session = await requireSessionForConnector(input.syncId, connector.rowId, connector.userId);

  // --- Duplicate batch? Replay stored ACK --------------------------------
  // Checked before the status guard so retries of already-processed batches
  // remain safe even if the session has since been completed.
  const existingBatch = await getBatch(session.id, input.batchNumber);

  if (existingBatch) {
    const ack = JSON.parse((existingBatch.ack_json as string) || "{}");
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
  const company = await requireCompanyAccess(connector.userId, session.company_id);
  if (input.companyId && input.companyId !== company.id) {
    throw new ApiError("INVALID_COMPANY", "companyId does not match the sync session");
  }

  // --- Store raw payloads first (staging) --------------------------------
  await storeRawRecords({
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

  for (const raw of input.records) {
    try {
      // 1. Resolve source identity (GUID preferred, deterministic fallback)
      const sourceObjectId = resolveSourceObjectId(input.entityType, raw);

      // 2. Content hash for change detection
      const contentHash = sha256(JSON.stringify(raw.data ?? raw));

      // 3. Idempotency check
      const existing = await getSourceRecord(
        connector.userId,
        session.company_id,
        input.entityType,
        sourceObjectId
      );

      if (existing && existing.content_hash === contentHash) {
        // Identical retransmission — count as duplicate, no writes
        duplicates++;
        continue;
      }

      // 4. Normalize into WhizUnik records
      const result = await normalizeRecord({
        userId: connector.userId,
        companyId: session.company_id,
        entityType: input.entityType,
        record: raw,
        sourceObjectId,
      });

      // 5. Record source identity (upsert guards concurrency)
      if (existing) {
        await putSourceRecord({
          user_id: connector.userId,
          company_id: session.company_id,
          entity_type: input.entityType,
          source_object_id: sourceObjectId,
          content_hash: contentHash,
          whizunik_table: result.table,
          whizunik_record_id: result.recordId,
          sync_id: session.sync_id,
        });
        accepted++; // update of changed content
      } else {
        try {
          await putSourceRecord({
            user_id: connector.userId,
            company_id: session.company_id,
            entity_type: input.entityType,
            source_object_id: sourceObjectId,
            source_company_id: company.tally_company_guid,
            source_voucher_number: raw.voucherNumber ?? null,
            source_voucher_type: raw.voucherType ?? null,
            source_voucher_date: raw.voucherDate ?? null,
            content_hash: contentHash,
            whizunik_table: result.table,
            whizunik_record_id: result.recordId,
            sync_id: session.sync_id,
          });
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
  await createBatch({
    id: uuidv4(),
    user_id: connector.userId,
    sync_row_id: session.id,
    sync_id: session.sync_id,
    batch_number: input.batchNumber,
    status: "ACCEPTED",
    accepted,
    duplicates,
    failed,
    ack_json: JSON.stringify(ack),
    request_id: requestId ?? null,
  });

  // --- Update session counters --------------------------------------------
  const fresh = (await getSessionBySyncId(session.sync_id)) || session;
  await applyBatchCounters(fresh as any, { accepted, duplicates, failed });

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
export async function sessionBySyncId(syncId: string) {
  return getSessionBySyncId(syncId);
}

export { getNormalizedTargetTable };
