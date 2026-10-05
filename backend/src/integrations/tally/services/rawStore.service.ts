import { v4 as uuidv4 } from "uuid";
import db from "../../../db/index.js";
import { config } from "../utils/env.js";
import { logInfo } from "../utils/logger.js";

/**
 * Controlled raw/staging layer: original connector payloads are retained for
 * debugging/reprocessing within the retention window, then purged.
 * Never log payload contents — only ids and counts.
 */
export function storeRawRecords(params: {
  userId: string;
  connectorRowId: string;
  companyId: string | null;
  syncId: string | null;
  entityType: string;
  records: Array<{ sourceObjectId?: string | null; payload: unknown }>;
}): void {
  if (params.records.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO tally_raw_records
       (id, user_id, connector_id, company_id, sync_id, entity_type, source_object_id, payload, processing_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`
  );

  const tx = db.transaction(() => {
    for (const rec of params.records) {
      insert.run(
        uuidv4(),
        params.userId,
        params.connectorRowId,
        params.companyId,
        params.syncId,
        params.entityType,
        rec.sourceObjectId ?? null,
        JSON.stringify(rec.payload)
      );
    }
  });
  tx();
}

/** Mark raw records for a sync as processed (or failed) after normalization. */
export function markRawProcessed(syncId: string, status: "PROCESSED" | "FAILED", errorMessage?: string): void {
  db.prepare(
    `UPDATE tally_raw_records
     SET processing_status = ?, processed_at = datetime('now'), error_message = COALESCE(?, error_message)
     WHERE sync_id = ? AND processing_status = 'PENDING'`
  ).run(status, errorMessage ?? null, syncId);
}

/**
 * Periodic retention cleanup. Returns a stop function; interval 0 disables.
 */
export function startTallyRetentionJob(): () => void {
  const intervalMs = config.rawRetentionCleanupIntervalMin * 60_000;
  if (intervalMs <= 0) return () => {};

  const purge = () => {
    try {
      const cutoff = new Date(Date.now() - config.rawRetentionDays * 86_400_000).toISOString();
      const res = db.prepare(
        `DELETE FROM tally_raw_records WHERE received_at < ?`
      ).run(cutoff);
      if (res.changes > 0) {
        logInfo("retention", null, `Purged ${res.changes} raw record(s) older than ${config.rawRetentionDays}d`);
      }
    } catch (err) {
      console.error("[tally][retention] Purge failed:", err);
    }
  };

  const timer = setInterval(purge, intervalMs);
  // Run shortly after boot so the first sweep happens without waiting an hour.
  setTimeout(purge, 30_000).unref?.();
  timer.unref?.();

  logInfo("retention", null, `Raw-record retention job started (${config.rawRetentionDays}d window)`);
  return () => clearInterval(timer);
}
