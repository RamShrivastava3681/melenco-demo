import { listConnectorsForUser, isHeartbeatFresh, type ConnectorRow } from "./connector.service.js";
import { listCompaniesForUser } from "./company.service.js";
import { listWConnectorsForTenant, listWCompaniesForTenant, listWSyncBatches } from "../../../db/storesWhizunik.js";
import { listSessionsForUser, latestConnectorEvent, listAuditForUser } from "../../../db/storesTally.js";
import { dbQueryPk } from "../../../db/dynamo.js";
import { userPk } from "../../../db/keys.js";
import { config } from "../utils/env.js";

/** Public (frontend-safe) shape of a connector. No token hashes, no secrets. */
export interface ConnectorStatus {
  id: string;
  connectorId: string;
  name: string;
  status: string;
  online: boolean;
  deviceName: string | null;
  appVersion: string | null;
  lastHeartbeat: string | null;
  lastSync: string | null;
  lastSuccessfulSync: string | null;
  createdAt: string;
}

export interface CurrentSyncProgress {
  syncId: string;
  entityType: string;
  syncType: string;
  status: string;
  totalRecords: number;
  processedRecords: number;
  totalBatches: number;
  processedBatches: number;
  failedRecords: number;
  duplicateRecords: number;
  startedAt: string;
}

export function toConnectorStatus(c: ConnectorRow): ConnectorStatus {
  return {
    id: c.id,
    connectorId: c.connector_id,
    name: c.connector_name,
    status: c.status,
    online: c.status === "ONLINE" && isHeartbeatFresh(c),
    deviceName: c.device_name,
    appVersion: c.app_version,
    lastHeartbeat: c.last_heartbeat,
    lastSync: c.last_sync,
    lastSuccessfulSync: c.last_successful_sync,
    createdAt: c.created_at,
  };
}

/** Aggregate status payload for the WhizUnik frontend Integrations page. */
export async function buildStatusPayload(userId: string) {
  const [connectorRows, companyRows] = await Promise.all([
    listConnectorsForUser(userId),
    listCompaniesForUser(userId),
  ]);
  const connectors: ConnectorStatus[] = connectorRows.map(toConnectorStatus);
  const companies = companyRows.map((c: any) => ({
    id: c.id,
    tallyCompanyGuid: c.tally_company_guid,
    tallyCompanyName: c.tally_company_name,
  }));

  // Merge in WhizUnik Cloud API (new-spec) connectors/companies for this
  // tenant so the platform shows everything it has received, regardless of
  // which connector protocol paired the device. Only live ('active')
  // connectors are listed — disconnected / superseded devices disappear
  // from the dashboard instead of lingering as ghosts.
  try {
    const wzConnectors = await listWConnectorsForTenant(userId, true);
    const sorted = [...wzConnectors].sort((a, b) =>
      String(b.created_at || "").localeCompare(String(a.created_at || ""))
    );
    for (const w of sorted) {
      if (connectors.some((c) => c.connectorId === w.connector_id)) continue;
      connectors.push({
        id: w.id as string,
        connectorId: w.connector_id as string,
        name: (w.device_name as string) || "Tally Connector",
        status: w.status as string,
        online: w.status === "active" && isWzHeartbeatFresh(w.last_heartbeat as string | null),
        deviceName: (w.device_name as string) || null,
        appVersion: (w.app_version as string) || null,
        lastHeartbeat: (w.last_heartbeat as string) || null,
        lastSync: (w.last_sync as string) || null,
        lastSuccessfulSync: (w.last_sync as string) || null,
        createdAt: w.created_at as string,
      });
    }
    const wzCompanies = await listWCompaniesForTenant(userId);
    for (const w of wzCompanies) {
      if (companies.some((c) => c.id === w.id)) continue;
      companies.push({ id: w.id as string, tallyCompanyGuid: (w.tally_guid as string) ?? "", tallyCompanyName: w.name as string });
    }
  } catch {
    // New-spec tables predate this deployment — legacy payload still served.
  }

  // Current (active) sync per user — the most recent RUNNING/PENDING session
  const activeSessions = await listSessionsForUser(userId, ["PENDING", "RUNNING"]);
  activeSessions.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
  const activeSession = activeSessions[0] as any | undefined;

  const currentSync: CurrentSyncProgress | null = activeSession
    ? {
        syncId: activeSession.sync_id,
        entityType: activeSession.entity_type,
        syncType: activeSession.sync_type,
        status: activeSession.status,
        totalRecords: activeSession.total_records,
        processedRecords: activeSession.processed_records,
        totalBatches: activeSession.total_batches,
        processedBatches: activeSession.processed_batches,
        failedRecords: activeSession.failed_records,
        duplicateRecords: activeSession.duplicate_records,
        startedAt: activeSession.started_at,
      }
    : null;

  // Last completed session summary
  const pastSessions = await listSessionsForUser(userId, ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);
  pastSessions.sort((a, b) => String(b.completed_at || "").localeCompare(String(a.completed_at || "")));
  const lastSession = pastSessions[0] as any | undefined;

  // Fall back to WhizUnik Cloud API batches (sessionless ingest) so the
  // platform always shows the latest received data, even without a legacy
  // sync session.
  let lastSync: {
    syncId: string;
    entityType: string;
    status: string;
    completedAt: string | null;
    successfulRecords: number;
    failedRecords: number;
    duplicateRecords: number;
  } | null = lastSession
    ? {
        syncId: lastSession.sync_id,
        entityType: lastSession.entity_type,
        status: lastSession.status,
        completedAt: lastSession.completed_at,
        successfulRecords: lastSession.successful_records,
        failedRecords: lastSession.failed_records,
        duplicateRecords: lastSession.duplicate_records,
      }
    : null;

  if (!lastSync) {
    try {
      const batches = await listWSyncBatches(userId, undefined, 1);
      const latest = batches[0] as any | undefined;
      if (latest) {
        lastSync = {
          syncId: latest.sync_id,
          entityType: latest.entity_type,
          status: "COMPLETED",
          completedAt: latest.created_at,
          successfulRecords: latest.received_count,
          failedRecords: 0,
          duplicateRecords: 0,
        };
      }
    } catch {
      // ignore — no new-spec data yet
    }
  }

  const hasPairedConnector = connectors.length > 0;
  return {
    connected: hasPairedConnector,
    pairingCodeTtlMinutes: config.pairingCodeTtlMinutes,
    connectors,
    companies,
    currentSync,
    lastSync,
    lastConnection: await buildLastConnection(userId, connectors),
    pendingPairing: await getPendingPairing(userId),
  };
}

/** Most recent successful connect for this tenant — drives the "Connected ✓" banner. */
export async function buildLastConnection(
  userId: string,
  connectors: ConnectorStatus[]
): Promise<{
  connectorId: string;
  connectorName: string;
  connectedAt: string;
  deviceName: string | null;
  appVersion: string | null;
} | null> {
  try {
    // Prefer the audit trail (covers legacy connects); fall back to newest
    // connector row (covers new-spec wz connects that predate audit writes).
    // `connectors` here holds only live devices — if the audited connect
    // belongs to a device that has since been disconnected, ignore it so the
    // "Connected" banner disappears instead of going stale.
    const evt = await latestConnectorEvent(userId, "CONNECTOR_CONNECTED") as { connector_id: string | null; created_at: string } | undefined;
    if (evt) {
      const match = evt.connector_id
        ? connectors.find((c) => c.connectorId === evt.connector_id)
        : undefined;
      if (match) {
        return {
          connectorId: evt.connector_id ?? match.connectorId,
          connectorName: match.name,
          connectedAt: evt.created_at,
          deviceName: match.deviceName,
          appVersion: match.appVersion,
        };
      }
      // Stale audit for a disconnected device — fall through to newest live
      // device below (or null when none remain).
    }
  } catch {
    // audit table may not exist in isolation — fall through to row fallback
  }
  if (connectors.length === 0) return null;
  const newest = [...connectors].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1
  )[0];
  return {
    connectorId: newest.connectorId,
    connectorName: newest.name,
    connectedAt: newest.createdAt,
    deviceName: newest.deviceName,
    appVersion: newest.appVersion,
  };
}

/** Whether the user has an unused, unexpired pairing code (legacy table). */
export async function getPendingPairing(userId: string): Promise<{ active: boolean; expiresAt: string | null }> {
  try {
    const rows = await dbQueryPk(userPk(userId), "PAIRING#");
    const now = new Date().toISOString();
    const match = rows
      .filter((r) => !r.used_at && String(r.expires_at || "") > now)
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
    if (match) return { active: true, expiresAt: match.expires_at as string };
  } catch {
    // ignore — legacy table may not exist
  }
  return { active: false, expiresAt: null };
}

/** Freshness check for WhizUnik Cloud API connector heartbeats. */
function isWzHeartbeatFresh(lastHeartbeat: string | null): boolean {
  if (!lastHeartbeat) return false;
  const last = new Date(
    lastHeartbeat.endsWith("Z") ? lastHeartbeat : lastHeartbeat + "Z"
  ).getTime();
  return Date.now() - last < config.heartbeatStaleMinutes * 60_000;
}

/** Sync history with optional filters. */
export async function listSyncHistory(
  userId: string,
  opts: { limit?: number; connectorId?: string; status?: string } = {}
) {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  let rows = await listSessionsForUser(userId);

  if (opts.connectorId) {
    const { getConnectorByPublicId } = await import("./connector.service.js");
    const conn = await getConnectorByPublicId(opts.connectorId);
    rows = rows.filter((r) => (conn ? r.connector_id === conn.id : false) && r.user_id === userId);
  }
  if (opts.status) {
    rows = rows.filter((r) => r.status === opts.status);
  }
  rows.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
  return rows.slice(0, limit).map((r) => ({
    sync_id: r.sync_id,
    connector_id: r.connector_id,
    company_id: r.company_id,
    tally_company_id: r.tally_company_id,
    sync_type: r.sync_type,
    entity_type: r.entity_type,
    status: r.status,
    started_at: r.started_at,
    completed_at: r.completed_at,
    total_records: r.total_records,
    processed_records: r.processed_records,
    successful_records: r.successful_records,
    duplicate_records: r.duplicate_records,
    failed_records: r.failed_records,
    total_batches: r.total_batches,
    processed_batches: r.processed_batches,
    error_message: r.error_message,
  }));
}

/** Recent audit events for the frontend activity feed. */
export async function listAuditEvents(userId: string, limit = 50) {
  const rows = await listAuditForUser(userId, Math.min(limit, 200));
  return rows.map((r) => ({
    event: r.event,
    connector_id: r.connector_id,
    sync_id: r.sync_id,
    request_id: r.request_id,
    detail: r.detail,
    created_at: r.created_at,
  }));
}
