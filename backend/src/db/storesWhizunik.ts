/** WhizUnik cloud API entity stores (tenant-scoped single-table items). */
import { v4 as uuidv4 } from "uuid";
import {
  dbPut,
  dbGet,
  dbUpdate,
  dbQueryPk,
  dbScan,
  type DbItem,
} from "./dynamo.js";
import {
  nowIso,
  tenantPk,
  tenantSk,
  wConnectorSk,
  wCompanySk,
  wBatchSk,
  wPairingSk,
  wRecordSk,
  wCommandSk,
  mLinkSk,
  mAttemptSk,
} from "./keys.js";

// --- Tenants ---
export async function getTenant(id: string): Promise<DbItem | undefined> {
  const direct = await dbGet<DbItem>(tenantPk(id), tenantSk(id));
  if (direct) return direct;
  const found = await dbScan((it) => it.recordType === "TENANT" && it.id === id, 2);
  return found[0];
}

export async function ensureTenant(id: string, name?: string): Promise<DbItem> {
  const existing = await getTenant(id);
  if (existing) return existing;
  const item: DbItem = {
    pk: tenantPk(id),
    sk: tenantSk(id),
    recordType: "TENANT",
    id,
    name: name || "Tenant",
    created_at: nowIso(),
  };
  await dbPut(item);
  return item;
}

// --- Connectors (whizunik) ---
export async function getWConnectorByPublicId(connectorId: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "WCONNECTOR" && it.connector_id === connectorId, 2);
  return found[0];
}

export async function getWConnectorByRowId(rowId: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "WCONNECTOR" && it.id === rowId, 2);
  return found[0];
}

export async function listWConnectorsForTenant(tenantId: string, onlyActive = false): Promise<DbItem[]> {
  let rows = await dbQueryPk(tenantPk(tenantId), "WCONNECTOR#");
  if (onlyActive) rows = rows.filter((r) => r.status === "active");
  return rows;
}

export async function findWConnectorByDevice(tenantId: string, deviceId: string, excludeConnectorId?: string): Promise<DbItem | undefined> {
  const rows = await dbQueryPk(tenantPk(tenantId), "WCONNECTOR#");
  return rows.find(
    (r) => r.device_id === deviceId && r.status === "active" && r.connector_id !== excludeConnectorId
  );
}

export async function createWConnector(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: tenantPk(data.tenant_id),
    sk: wConnectorSk(id),
    recordType: "WCONNECTOR",
    id,
    status: "active",
    created_at: nowIso(),
    updated_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function updateWConnector(row: DbItem, attrs: Record<string, any>): Promise<DbItem | undefined> {
  return dbUpdate<DbItem>(row.pk, row.sk, { ...attrs, updated_at: nowIso() });
}

export async function updateWCompany(row: DbItem, attrs: Record<string, any>): Promise<DbItem | undefined> {
  return dbUpdate<DbItem>(row.pk, row.sk, attrs);
}

// --- Companies (whizunik) ---
export async function getWCompany(id: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "WCOMPANY" && it.id === id, 2);
  return found[0];
}

export async function findWCompanyByGuid(tenantId: string, guid: string): Promise<DbItem | undefined> {
  const rows = await dbQueryPk(tenantPk(tenantId), "WCOMPANY#");
  return rows.find((r) => r.tally_guid === guid);
}

export async function findWCompanyByName(tenantId: string, name: string): Promise<DbItem | undefined> {
  const rows = await dbQueryPk(tenantPk(tenantId), "WCOMPANY#");
  return rows.find((r) => r.name === name);
}

export async function latestWCompanyForTenant(tenantId: string): Promise<DbItem | undefined> {
  const rows = await dbQueryPk(tenantPk(tenantId), "WCOMPANY#");
  rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return rows[0];
}

export async function listWCompaniesForTenant(tenantId: string): Promise<DbItem[]> {
  return dbQueryPk(tenantPk(tenantId), "WCOMPANY#");
}

export async function createWCompany(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: tenantPk(data.tenant_id),
    sk: wCompanySk(id),
    recordType: "WCOMPANY",
    id,
    name: "Company",
    created_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

// --- Sync batches (whizunik) ---
export async function getWSyncBatchByBatchId(batchId: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "WSYNCBATCH" && it.batch_id === batchId, 3);
  return found[0];
}

export async function getWSyncBatchByRequestId(requestId: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "WSYNCBATCH" && it.request_id === requestId, 3);
  return found[0];
}

export async function createWSyncBatch(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: tenantPk(data.tenant_id),
    sk: wBatchSk(data.batch_id),
    recordType: "WSYNCBATCH",
    id,
    created_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function listWSyncBatches(
  tenantId: string,
  filters?: { company_id?: string; entity_type?: string },
  limit = 50
): Promise<DbItem[]> {
  let rows = await dbQueryPk(tenantPk(tenantId), "WSYNCBATCH#");
  if (filters?.company_id) rows = rows.filter((r) => r.company_id === filters.company_id);
  if (filters?.entity_type) rows = rows.filter((r) => r.entity_type === filters.entity_type);
  rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return rows.slice(0, limit);
}

// --- Pairing codes (whizunik, pk = code) ---
export async function getWPairing(code: string): Promise<DbItem | undefined> {
  const found = await dbScan((it) => it.recordType === "WPAIRING" && it.code === code, 2);
  return found[0];
}

export async function createWPairing(data: Record<string, any>): Promise<DbItem> {
  const item: DbItem = {
    pk: tenantPk(data.tenant_id),
    sk: wPairingSk(data.code),
    recordType: "WPAIRING",
    created_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function markWPairingUsed(row: DbItem): Promise<void> {
  await dbUpdate(row.pk, row.sk, { used_at: nowIso() });
}

// --- Sync records (whizunik) ---
export async function createWSyncRecord(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: tenantPk(data.tenant_id),
    sk: wRecordSk(id),
    recordType: "WSYNCRECORD",
    id,
    created_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function listWSyncRecords(
  tenantId: string,
  filters?: { company_id?: string; entity_type?: string; batch_id?: string },
  limit = 50,
  offset = 0
): Promise<DbItem[]> {
  let rows = await dbQueryPk(tenantPk(tenantId), "WSYNCRECORD#");
  if (filters?.company_id) rows = rows.filter((r) => r.company_id === filters.company_id);
  if (filters?.entity_type) rows = rows.filter((r) => r.entity_type === filters.entity_type);
  if (filters?.batch_id) rows = rows.filter((r) => r.batch_id === filters.batch_id);
  rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return rows.slice(offset, offset + limit);
}

// --- Connector commands (whizunik) ---
export async function createWCommand(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: tenantPk(data.tenant_id),
    sk: wCommandSk(id),
    recordType: "WCOMMAND",
    id,
    status: "PENDING",
    created_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function getWCommand(id: string, tenantId?: string): Promise<DbItem | undefined> {
  if (tenantId) {
    const direct = await dbGet<DbItem>(tenantPk(tenantId), wCommandSk(id));
    if (direct) return direct;
  }
  const found = await dbScan((it) => it.recordType === "WCOMMAND" && it.id === id, 2);
  return found[0];
}

export async function listPendingWCommands(connectorId: string, limit = 20): Promise<DbItem[]> {
  const rows = await dbScan(
    (it) => it.recordType === "WCOMMAND" && it.connector_id === connectorId && it.status === "PENDING"
  );
  rows.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return rows.slice(0, limit);
}

export async function listWCommands(tenantId: string, connectorId?: string, limit = 50): Promise<DbItem[]> {
  let rows = await dbQueryPk(tenantPk(tenantId), "WCOMMAND#");
  if (connectorId) rows = rows.filter((r) => r.connector_id === connectorId);
  rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return rows.slice(0, limit);
}

export async function updateWCommand(row: DbItem, attrs: Record<string, any>): Promise<DbItem | undefined> {
  return dbUpdate<DbItem>(row.pk, row.sk, attrs);
}

// --- Master sync links ---
export async function getMasterLink(tenantId: string, kind: string, whizunikId: string): Promise<DbItem | undefined> {
  return dbGet<DbItem>(tenantPk(tenantId), mLinkSk(kind, whizunikId));
}

export async function putMasterLink(data: Record<string, any>): Promise<DbItem> {
  const existing = await getMasterLink(data.tenant_id, data.kind, data.whizunik_id);
  if (existing) {
    const next = (await dbUpdate<DbItem>(existing.pk, existing.sk, {
      ...data,
      updated_at: nowIso(),
    })) as DbItem;
    return next;
  }
  const item: DbItem = {
    pk: tenantPk(data.tenant_id),
    sk: mLinkSk(data.kind, data.whizunik_id),
    recordType: "MSYNCLINK",
    created_at: nowIso(),
    updated_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function updateMasterLink(
  tenantId: string,
  kind: string,
  whizunikId: string,
  attrs: Record<string, any>
): Promise<DbItem | undefined> {
  const existing = await getMasterLink(tenantId, kind, whizunikId);
  if (!existing) return undefined;
  return dbUpdate<DbItem>(existing.pk, existing.sk, { ...attrs, updated_at: nowIso() });
}

// --- Master sync attempts ---
export async function createMasterAttempt(data: Record<string, any>): Promise<DbItem> {
  const id = data.id || uuidv4();
  const item: DbItem = {
    pk: tenantPk(data.tenant_id),
    sk: mAttemptSk(id),
    recordType: "MSYNCATTEMPT",
    id,
    requested_at: nowIso(),
    ...data,
  };
  await dbPut(item);
  return item;
}

export async function listMasterAttempts(
  tenantId: string,
  kind: string,
  whizunikId: string,
  limit = 20
): Promise<DbItem[]> {
  const rows = await dbQueryPk(tenantPk(tenantId), "MSYNCATTEMPT#");
  const match = rows.filter((r) => r.kind === kind && r.whizunik_id === whizunikId);
  match.sort((a, b) => String(b.requested_at || "").localeCompare(String(a.requested_at || "")));
  return match.slice(0, limit);
}
