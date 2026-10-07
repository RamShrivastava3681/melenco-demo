/** Tally integration entity stores (user-scoped single-table items). */
import { v4 as uuidv4 } from "uuid";
import {
  dbPut,
  dbGet,
  dbDelete,
  dbUpdate,
  dbQueryPk,
  dbScan,
  type DbItem,
} from "./dynamo.js";
import {
  nowIso,
  userPk,
  companySk,
  connectorSk,
  pairingSk,
  sessionSk,
  batchSk,
  sourceSk,
  rawSk,
  checkpointSk,
  auditSk,
  ledgerSk,
  purchaseInvoiceSk,
  voucherSk,
  reportSk,
  commandSk,
} from "./keys.js";

// --- Companies ---
export async function getCompany(userId: string, id: string): Promise<DbItem | undefined> {
  return dbGet<DbItem>(userPk(userId), companySk(id));
}

export async function findCompanyByGuid(userId: string, guid: string): Promise<DbItem | undefined> {
  const rows = await dbQueryPk(userPk(userId), "COMPANY#");
  return rows.find((r) => r.tally_company_guid === guid);
}

export async function listCompanies(userId: string): Promise<DbItem[]> {
  const rows = await dbQueryPk(userPk(userId), "COMPANY#");
  rows.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return rows;
}

export async function createCompany(userId: string, guid: string, name: string): Promise<DbItem> {
  const id = uuidv4();
  const item: DbItem = {
    pk: userPk(userId),
    sk: companySk(id),
    recordType: "TALLY_COMPANY",
    id,
    user_id: userId,
    tally_company_guid: guid,
    tally_company_name: name,
    display_name: null,
    created_at: nowIso(),
  };
  await dbPut(item);
  return item;
}

// --- Connectors ---
export async function getConnectorByRowId(rowId: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "TALLY_CONNECTOR" && it.id === rowId, 2);
  return found[0];
}

export async function getConnectorByPublicId(connectorId: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "TALLY_CONNECTOR" && it.connector_id === connectorId, 2);
  return found[0];
}

export async function listConnectorsForUser(userId: string): Promise<DbItem[]> {
  const rows = await dbQueryPk(userPk(userId), "CONNECTOR#");
  const active = rows.filter((r) => r.status !== "REVOKED");
  active.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return active;
}

export async function connectorPublicIdExists(connectorId: string): Promise<boolean> {
  const found = await getConnectorByPublicId(connectorId);
  return !!found;
}

export async function createConnectorRow(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: userPk(data.user_id),
    sk: connectorSk(id),
    recordType: "TALLY_CONNECTOR",
    id,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function updateConnectorByRowId(rowId: string, attrs: Record<string, any>): Promise<DbItem | undefined> {
  const row = await getConnectorByRowId(rowId);
  if (!row) return undefined;
  return dbUpdate<DbItem>(row.pk, row.sk, { ...attrs, updated_at: nowIso() });
}

// --- Pairing codes ---
export async function createPairingRow(userId: string, codeHash: string, expiresAt: string): Promise<DbItem> {
  const id = uuidv4();
  const item: DbItem = {
    pk: userPk(userId),
    sk: pairingSk(id),
    recordType: "TALLY_PAIRING",
    id,
    user_id: userId,
    code_hash: codeHash,
    expires_at: expiresAt,
    used_at: null,
    attempts: 0,
    created_at: nowIso(),
  };
  await dbPut(item);
  return item;
}

export async function getPairingByCodeHash(codeHash: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "TALLY_PAIRING" && it.code_hash === codeHash, 2);
  return found[0];
}

export async function markPairingUsed(row: DbItem): Promise<void> {
  await dbUpdate(row.pk, row.sk, { used_at: nowIso() });
}

// --- Sync sessions ---
export async function getSessionBySyncId(syncId: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "TALLY_SESSION" && it.sync_id === syncId, 2);
  return found[0];
}

export async function getActiveSession(connectorRowId: string, companyId: string, entityType: string): Promise<DbItem | undefined> {
  const found = await dbScan(
    (it) =>
      it.recordType === "TALLY_SESSION" &&
      it.connector_id === connectorRowId &&
      it.company_id === companyId &&
      it.entity_type === entityType &&
      (it.status === "PENDING" || it.status === "RUNNING"),
    5
  );
  found.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
  return found[0];
}

export async function listActiveSessionsForConnector(connectorRowId: string, entityType?: string): Promise<DbItem[]> {
  return dbScan(
    (it) =>
      it.recordType === "TALLY_SESSION" &&
      it.connector_id === connectorRowId &&
      (it.status === "PENDING" || it.status === "RUNNING") &&
      (!entityType || it.entity_type === entityType)
  );
}

export async function createSession(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: userPk(data.user_id),
    sk: sessionSk(data.sync_id),
    recordType: "TALLY_SESSION",
    id,
    status: "RUNNING",
    started_at: nowIso(),
    total_records: 0,
    processed_records: 0,
    successful_records: 0,
    duplicate_records: 0,
    failed_records: 0,
    total_batches: 0,
    processed_batches: 0,
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function updateSession(row: DbItem, attrs: Record<string, any>): Promise<DbItem | undefined> {
  return dbUpdate<DbItem>(row.pk, row.sk, attrs);
}

export async function cancelActiveSessionsForConnector(connectorRowId: string, entityType?: string): Promise<void> {
  const rows = await listActiveSessionsForConnector(connectorRowId, entityType);
  for (const r of rows) {
    await dbUpdate(r.pk, r.sk, {
      status: "CANCELLED",
      completed_at: nowIso(),
      error_message: r.error_message || "Connector disconnected",
    });
  }
}

export async function listSessionsForUser(userId: string, statuses?: string[]): Promise<DbItem[]> {
  let rows = await dbQueryPk(userPk(userId), "SESSION#");
  if (statuses) rows = rows.filter((r) => statuses.includes(r.status));
  return rows;
}

// --- Batches ---
export async function getBatch(sessionRowId: string, batchNumber: number): Promise<DbItem | undefined> {
  const found = await dbScan(
    (it) => it.recordType === "TALLY_BATCH" && it.sync_row_id === sessionRowId && it.batch_number === batchNumber,
    2
  );
  return found[0];
}

export async function createBatch(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: userPk(data.user_id),
    sk: batchSk(data.sync_row_id, data.batch_number),
    recordType: "TALLY_BATCH",
    id,
    created_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

// --- Source records (idempotency spine) ---
export async function getSourceRecord(
  userId: string,
  _companyId: string,
  entityType: string,
  sourceObjectId: string
): Promise<DbItem | undefined> {
  return dbGet<DbItem>(userPk(userId), sourceSk(entityType, sourceObjectId));
}

export async function putSourceRecord(data: Record<string, any>): Promise<DbItem> {
  const existing = await getSourceRecord(data.user_id, data.company_id, data.entity_type, data.source_object_id);
  if (existing) {
    const next = (await dbUpdate<DbItem>(existing.pk, existing.sk, {
      content_hash: data.content_hash,
      whizunik_table: data.whizunik_table,
      whizunik_record_id: data.whizunik_record_id,
      last_seen_at: nowIso(),
      sync_id: data.sync_id,
    })) as DbItem;
    return next;
  }
  const id = uuidv4();
  const item: DbItem = {
    pk: userPk(data.user_id),
    sk: sourceSk(data.entity_type, data.source_object_id),
    recordType: "TALLY_SOURCE",
    id,
    source: "tally",
    first_seen_at: nowIso(),
    last_seen_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

// --- Raw records ---
export async function createRawRecords(items: Array<Record<string, any>>): Promise<void> {
  for (const data of items) {
    const id = uuidv4();
    await dbPut({
      pk: userPk(data.user_id),
      sk: rawSk(id),
      recordType: "TALLY_RAW",
      id,
      processing_status: "PENDING",
      received_at: nowIso(),
      ...data,
    });
  }
}

export async function markRawProcessed(syncId: string, status: "PROCESSED" | "FAILED", errorMessage?: string): Promise<void> {
  const rows = await dbScan(
    (it) => it.recordType === "TALLY_RAW" && it.sync_id === syncId && it.processing_status === "PENDING"
  );
  for (const r of rows) {
    await dbUpdate(r.pk, r.sk, {
      processing_status: status,
      processed_at: nowIso(),
      error_message: errorMessage ?? r.error_message ?? null,
    });
  }
}

export async function purgeRawOlderThan(cutoffIso: string): Promise<number> {
  const rows = await dbScan(
    (it) => it.recordType === "TALLY_RAW" && String(it.received_at || "") < cutoffIso
  );
  for (const r of rows) {
    await dbDelete(r.pk, r.sk);
  }
  return rows.length;
}

export async function listRawBySyncId(syncId: string): Promise<DbItem[]> {
  return dbScan((it) => it.recordType === "TALLY_RAW" && it.sync_id === syncId);
}

// --- Checkpoints ---
export async function getCheckpoint(userId: string, companyId: string, entityType: string): Promise<DbItem | undefined> {
  return dbGet<DbItem>(userPk(userId), checkpointSk(companyId, entityType));
}

export async function recordCheckpointData(
  userId: string,
  companyId: string,
  entityType: string,
  fields: { lastObjectId?: string | null; lastVoucherDate?: string | null; lastVoucherNumber?: string | null }
): Promise<void> {
  const existing = await getCheckpoint(userId, companyId, entityType);
  if (!existing) {
    await dbPut({
      pk: userPk(userId),
      sk: checkpointSk(companyId, entityType),
      recordType: "TALLY_CHECKPOINT",
      id: uuidv4(),
      user_id: userId,
      company_id: companyId,
      entity_type: entityType,
      last_sync_at: nowIso(),
      last_object_id: fields.lastObjectId ?? null,
      last_voucher_date: fields.lastVoucherDate ?? null,
      last_voucher_number: fields.lastVoucherNumber ?? null,
      updated_at: nowIso(),
    });
    return;
  }
  const attrs: Record<string, any> = { last_sync_at: nowIso(), updated_at: nowIso() };
  if (fields.lastObjectId !== undefined && fields.lastObjectId !== null) attrs.last_object_id = fields.lastObjectId;
  if (fields.lastVoucherDate !== undefined && fields.lastVoucherDate !== null) attrs.last_voucher_date = fields.lastVoucherDate;
  if (fields.lastVoucherNumber !== undefined && fields.lastVoucherNumber !== null) attrs.last_voucher_number = fields.lastVoucherNumber;
  await dbUpdate(existing.pk, existing.sk, attrs);
}

export async function clearCheckpointData(userId: string, companyId: string, entityType: string): Promise<void> {
  await dbDelete(userPk(userId), checkpointSk(companyId, entityType));
}

export async function listCheckpointsForCompany(userId: string, companyId: string): Promise<DbItem[]> {
  const rows = await dbQueryPk(userPk(userId), "CHECKPOINT#");
  return rows.filter((r) => r.company_id === companyId);
}

// --- Audit ---
export async function writeAudit(entry: {
  userId: string;
  connectorId?: string | null;
  syncId?: string | null;
  event: string;
  requestId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const id = uuidv4();
    const created = nowIso();
    await dbPut({
      pk: userPk(entry.userId),
      sk: auditSk(created, id),
      recordType: "TALLY_AUDIT",
      id,
      user_id: entry.userId,
      connector_id: entry.connectorId ?? null,
      sync_id: entry.syncId ?? null,
      event: entry.event,
      request_id: entry.requestId ?? null,
      detail: entry.detail ? JSON.stringify(entry.detail) : null,
      created_at: created,
    });
  } catch (err) {
    console.error(`[tally][audit] Failed to record event ${entry.event}:`, err);
  }
}

export async function listAuditForUser(userId: string, limit = 100): Promise<DbItem[]> {
  const rows = await dbQueryPk(userPk(userId), "AUDIT#");
  rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return rows.slice(0, limit);
}

export async function latestConnectorEvent(userId: string, event: string): Promise<DbItem | undefined> {
  const rows = await dbQueryPk(userPk(userId), "AUDIT#");
  const match = rows.filter((r) => r.event === event);
  match.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return match[0];
}

// --- Ledgers ---
export async function findLedger(userId: string, companyId: string, name: string): Promise<DbItem | undefined> {
  const rows = await dbQueryPk(userPk(userId), "LEDGER#");
  return rows.find((r) => r.company_id === companyId && r.name === name);
}

export async function createLedger(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: userPk(data.user_id),
    sk: ledgerSk(id),
    recordType: "TALLY_LEDGER",
    id,
    opening_balance: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function updateLedger(row: DbItem, attrs: Record<string, any>): Promise<DbItem | undefined> {
  return dbUpdate<DbItem>(row.pk, row.sk, { ...attrs, updated_at: nowIso() });
}

// --- Purchase invoices ---
export async function findPurchaseInvoice(userId: string, supplierId: string, invoiceNumber: string): Promise<DbItem | undefined> {
  const rows = await dbQueryPk(userPk(userId), "PINVOICE#");
  return rows.find((r) => r.supplier_id === supplierId && r.invoice_number === invoiceNumber);
}

export async function createPurchaseInvoice(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: userPk(data.user_id),
    sk: purchaseInvoiceSk(id),
    recordType: "PURCHASE_INVOICE",
    id,
    status: "open",
    created_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

// --- Vouchers ---
export async function createVoucher(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: userPk(data.user_id),
    sk: voucherSk(id),
    recordType: "TALLY_VOUCHER",
    id,
    created_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function listVouchers(userId: string): Promise<DbItem[]> {
  return dbQueryPk(userPk(userId), "VOUCHER#");
}

// --- Reports ---
export async function putReport(data: Record<string, any>): Promise<DbItem> {
  const existing = await dbGet<DbItem>(
    userPk(data.user_id),
    reportSk(data.company_id, data.report_type, data.report_date || "")
  );
  if (existing) {
    const next = (await dbUpdate<DbItem>(existing.pk, existing.sk, {
      payload: data.payload,
      generated_at: nowIso(),
    })) as DbItem;
    return next;
  }
  const id = uuidv4();
  const item: DbItem = {
    pk: userPk(data.user_id),
    sk: reportSk(data.company_id, data.report_type, data.report_date || ""),
    recordType: "TALLY_REPORT",
    id,
    generated_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

// --- Sync commands (cloud -> connector) ---
export async function createSyncCommand(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: userPk(data.user_id),
    sk: commandSk(id),
    recordType: "TALLY_COMMAND",
    id,
    status: "PENDING",
    created_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function getSyncCommand(userId: string, id: string): Promise<DbItem | undefined> {
  return dbGet<DbItem>(userPk(userId), commandSk(id));
}

export async function getSyncCommandGlobal(id: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "TALLY_COMMAND" && it.id === id, 2);
  return found[0];
}

export async function listPendingCommandsForConnector(connectorRowId: string, limit = 20): Promise<DbItem[]> {
  const rows = await dbScan(
    (it) => it.recordType === "TALLY_COMMAND" && it.connector_id === connectorRowId && it.status === "PENDING"
  );
  rows.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return rows.slice(0, limit);
}

export async function updateSyncCommand(row: DbItem, attrs: Record<string, any>): Promise<DbItem | undefined> {
  return dbUpdate<DbItem>(row.pk, row.sk, attrs);
}

export async function listSyncCommandsForUser(userId: string): Promise<DbItem[]> {
  const rows = await dbQueryPk(userPk(userId), "COMMAND#");
  rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return rows;
}
