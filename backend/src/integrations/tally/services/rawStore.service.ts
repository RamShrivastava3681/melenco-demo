import { config } from "../utils/env.js";
import { logInfo } from "../utils/logger.js";
import { createRawRecords, markRawProcessed as markRaw, purgeRawOlderThan } from "../../../db/storesTally.js";

/**
 * Controlled raw/staging layer: original connector payloads are retained for
 * debugging/reprocessing within the retention window, then purged.
 * Never log payload contents — only ids and counts.
 */
export async function storeRawRecords(params: {
  userId: string;
  connectorRowId: string;
  companyId: string | null;
  syncId: string | null;
  entityType: string;
  records: Array<{ sourceObjectId?: string | null; payload: unknown }>;
}): Promise<void> {
  if (params.records.length === 0) return;

  await createRawRecords(
    params.records.map((rec) => ({
      user_id: params.userId,
      connector_id: params.connectorRowId,
      company_id: params.companyId,
      sync_id: params.syncId,
      entity_type: params.entityType,
      source_object_id: rec.sourceObjectId ?? null,
      payload: JSON.stringify(rec.payload),
    }))
  );
}

/** Mark raw records for a sync as processed (or failed) after normalization. */
export async function markRawProcessed(syncId: string, status: "PROCESSED" | "FAILED", errorMessage?: string): Promise<void> {
  await markRaw(syncId, status, errorMessage);
}

/**
 * Periodic retention cleanup. Returns a stop function; interval 0 disables.
 */
export function startTallyRetentionJob(): () => void {
  const intervalMs = config.rawRetentionCleanupIntervalMin * 60_000;
  if (intervalMs <= 0) return () => {};

  const purge = () => {
    void (async () => {
      try {
        const cutoff = new Date(Date.now() - config.rawRetentionDays * 86_400_000).toISOString();
        const purged = await purgeRawOlderThan(cutoff);
        if (purged > 0) {
          logInfo("retention", null, `Purged ${purged} raw record(s) older than ${config.rawRetentionDays}d`);
        }
      } catch (err) {
        console.error("[tally][retention] Purge failed:", err);
      }
    })();
  };

  const timer = setInterval(purge, intervalMs);
  // Run shortly after boot so the first sweep happens without waiting an hour.
  setTimeout(purge, 30_000).unref?.();
  timer.unref?.();

  logInfo("retention", null, `Raw-record retention job started (${config.rawRetentionDays}d window)`);
  return () => clearInterval(timer);
}
