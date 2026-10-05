import { v4 as uuidv4 } from "uuid";
import db from "../../../db/index.js";

export interface CheckpointRow {
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

export function getCheckpoint(
  userId: string,
  companyId: string,
  entityType: string
): CheckpointRow | undefined {
  return db
    .prepare(
      `SELECT * FROM tally_sync_checkpoints WHERE user_id = ? AND company_id = ? AND entity_type = ?`
    )
    .get(userId, companyId, entityType) as CheckpointRow | undefined;
}

/**
 * Persist the incremental checkpoint for a company + entity type.
 * Not every Tally object carries the same incremental identifier — the
 * connector declares which fields it tracks; unset fields stay unchanged.
 */
export function recordCheckpoint(params: {
  userId: string;
  companyId: string;
  entityType: string;
  lastObjectId?: string | null;
  lastVoucherDate?: string | null;
  lastVoucherNumber?: string | null;
}): void {
  const existing = getCheckpoint(params.userId, params.companyId, params.entityType);

  if (!existing) {
    db.prepare(
      `INSERT INTO tally_sync_checkpoints
         (id, user_id, company_id, entity_type, last_sync_at, last_object_id, last_voucher_date, last_voucher_number)
       VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)`
    ).run(
      uuidv4(),
      params.userId,
      params.companyId,
      params.entityType,
      params.lastObjectId ?? null,
      params.lastVoucherDate ?? null,
      params.lastVoucherNumber ?? null
    );
    return;
  }

  db.prepare(
    `UPDATE tally_sync_checkpoints
     SET last_sync_at = datetime('now'),
         last_object_id = COALESCE(?, last_object_id),
         last_voucher_date = COALESCE(?, last_voucher_date),
         last_voucher_number = COALESCE(?, last_voucher_number),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    params.lastObjectId ?? null,
    params.lastVoucherDate ?? null,
    params.lastVoucherNumber ?? null,
    existing.id
  );
}

/** Clear a checkpoint (used on FULL_RESYNC so the connector re-reads everything). */
export function clearCheckpoint(userId: string, companyId: string, entityType: string): void {
  db.prepare(
    `DELETE FROM tally_sync_checkpoints WHERE user_id = ? AND company_id = ? AND entity_type = ?`
  ).run(userId, companyId, entityType);
}

export function listCheckpointsForCompany(userId: string, companyId: string): CheckpointRow[] {
  return db
    .prepare(`SELECT * FROM tally_sync_checkpoints WHERE user_id = ? AND company_id = ?`)
    .all(userId, companyId) as CheckpointRow[];
}
