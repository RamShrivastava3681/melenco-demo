import {
  getCheckpoint as getCp,
  recordCheckpointData,
  clearCheckpointData,
  listCheckpointsForCompany as listCp,
} from "../../../db/storesTally.js";
import type { DbItem } from "../../../db/dynamo.js";

export interface CheckpointRow extends DbItem {
  id: string;
  user_id: string;
  company_id: string;
  entity_type: string;
  last_sync_at: string | null;
  last_object_id: string | null;
  last_voucher_date: string | null;
  last_voucher_number: string | null;
  updated_at: string;
}

export async function getCheckpoint(
  userId: string,
  companyId: string,
  entityType: string
): Promise<CheckpointRow | undefined> {
  return (await getCp(userId, companyId, entityType)) as CheckpointRow | undefined;
}

/**
 * Persist the incremental checkpoint for a company + entity type.
 * Not every Tally object carries the same incremental identifier — the
 * connector declares which fields it tracks; unset fields stay unchanged.
 */
export async function recordCheckpoint(params: {
  userId: string;
  companyId: string;
  entityType: string;
  lastObjectId?: string | null;
  lastVoucherDate?: string | null;
  lastVoucherNumber?: string | null;
}): Promise<void> {
  await recordCheckpointData(params.userId, params.companyId, params.entityType, {
    lastObjectId: params.lastObjectId,
    lastVoucherDate: params.lastVoucherDate,
    lastVoucherNumber: params.lastVoucherNumber,
  });
}

/** Clear a checkpoint (used on FULL_RESYNC so the connector re-reads everything). */
export async function clearCheckpoint(userId: string, companyId: string, entityType: string): Promise<void> {
  await clearCheckpointData(userId, companyId, entityType);
}

export async function listCheckpointsForCompany(userId: string, companyId: string): Promise<CheckpointRow[]> {
  return (await listCp(userId, companyId)) as CheckpointRow[];
}
