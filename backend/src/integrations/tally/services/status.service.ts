import db from "../../../db/index.js";
import { listConnectorsForUser, isHeartbeatFresh, type ConnectorRow } from "./connector.service.js";
import { listCompaniesForUser } from "./company.service.js";
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
export function buildStatusPayload(userId: string) {
  const connectors: ConnectorStatus[] = listConnectorsForUser(userId).map(toConnectorStatus);
  const companies = listCompaniesForUser(userId).map((c) => ({
    id: c.id,
    tallyCompanyGuid: c.tally_company_guid,
    tallyCompanyName: c.tally_company_name,
  }));

  // Merge in WhizUnik Cloud API (new-spec) connectors/companies for this
  // tenant so the platform shows everything it has received, regardless of
  // which connector protocol paired the device.
  try {
    const wzConnectors = db
      .prepare(
        `SELECT id, connector_id, device_name, status, app_version, last_heartbeat, last_sync, created_at
         FROM connectors WHERE tenant_id = ? ORDER BY created_at DESC`
      )
      .all(userId) as Array<{
        id: string;
        connector_id: string;
        device_name: string | null;
        status: string;
        app_version: string | null;
        last_heartbeat: string | null;
        last_sync: string | null;
        created_at: string;
      }>;
    for (const w of wzConnectors) {
      if (connectors.some((c) => c.connectorId === w.connector_id)) continue;
      connectors.push({
        id: w.id,
        connectorId: w.connector_id,
        name: w.device_name || "Tally Connector",
        status: w.status,
        online: w.status === "active" && isWzHeartbeatFresh(w.last_heartbeat),
        deviceName: w.device_name,
        appVersion: w.app_version,
        lastHeartbeat: w.last_heartbeat,
        lastSync: w.last_sync,
        lastSuccessfulSync: w.last_sync,
        createdAt: w.created_at,
      });
    }
    const wzCompanies = db
      .prepare(`SELECT id, tally_guid, name FROM companies WHERE tenant_id = ? ORDER BY created_at`)
      .all(userId) as Array<{ id: string; tally_guid: string | null; name: string }>;
    for (const w of wzCompanies) {
      if (companies.some((c) => c.id === w.id)) continue;
      companies.push({ id: w.id, tallyCompanyGuid: w.tally_guid ?? "", tallyCompanyName: w.name });
    }
  } catch {
    // New-spec tables predate this deployment — legacy payload still served.
  }

  // Current (active) sync per user — the most recent RUNNING/PENDING session
  const activeSession = db
    .prepare(
      `SELECT * FROM tally_sync_sessions
       WHERE user_id = ? AND status IN ('PENDING','RUNNING')
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(userId) as any | undefined;

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
  const lastSession = db
    .prepare(
      `SELECT sync_id, entity_type, status, completed_at, successful_records, failed_records, duplicate_records
       FROM tally_sync_sessions
       WHERE user_id = ? AND status IN ('COMPLETED','PARTIAL','FAILED','CANCELLED')
       ORDER BY completed_at DESC LIMIT 1`
    )
    .get(userId) as any | undefined;

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
      const latest = db
        .prepare(
          `SELECT sync_id, entity_type, received_count, created_at
           FROM sync_batches WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(userId) as
        | { sync_id: string; entity_type: string; received_count: number; created_at: string }
        | undefined;
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

  const hasOnlineConnector = connectors.some(
    (c) => c.status === "ONLINE" && c.online
  );
  return {
    connected: hasOnlineConnector,
    pairingCodeTtlMinutes: config.pairingCodeTtlMinutes,
    connectors,
    companies,
    currentSync,
    lastSync,
    lastConnection: buildLastConnection(userId, connectors),
    pendingPairing: getPendingPairing(userId),
  };
}

/** Most recent successful connect for this tenant — drives the "Connected ✓" banner. */
export function buildLastConnection(
  userId: string,
  connectors: ConnectorStatus[]
): {
  connectorId: string;
  connectorName: string;
  connectedAt: string;
  deviceName: string | null;
  appVersion: string | null;
} | null {
  try {
    // Prefer the audit trail (covers legacy connects); fall back to newest
    // connector row (covers new-spec wz connects that predate audit writes).
    const evt = db
      .prepare(
        `SELECT connector_id, created_at FROM tally_audit_logs
         WHERE user_id = ? AND event = 'CONNECTOR_CONNECTED'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(userId) as { connector_id: string | null; created_at: string } | undefined;
    if (evt) {
      const match = evt.connector_id
        ? connectors.find((c) => c.connectorId === evt.connector_id)
        : undefined;
      return {
        connectorId: evt.connector_id ?? match?.connectorId ?? "",
        connectorName: match?.name ?? "Tally Connector",
        connectedAt: evt.created_at,
        deviceName: match?.deviceName ?? null,
        appVersion: match?.appVersion ?? null,
      };
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
export function getPendingPairing(userId: string): { active: boolean; expiresAt: string | null } {
  try {
    const row = db
      .prepare(
        `SELECT expires_at FROM tally_pairing_codes
         WHERE user_id = ? AND used_at IS NULL AND expires_at > datetime('now')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(userId) as { expires_at: string } | undefined;
    if (row) return { active: true, expiresAt: row.expires_at };
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
export function listSyncHistory(
  userId: string,
  opts: { limit?: number; connectorId?: string; status?: string } = {}
) {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  let sql = `SELECT sync_id, connector_id, company_id, tally_company_id, sync_type, entity_type, status,
                    started_at, completed_at, total_records, processed_records, successful_records,
                    duplicate_records, failed_records, total_batches, processed_batches, error_message
             FROM tally_sync_sessions WHERE user_id = ?`;
  const params: any[] = [userId];

  if (opts.connectorId) {
    sql += ` AND connector_id = (SELECT id FROM tally_connectors WHERE connector_id = ? AND user_id = ?)`;
    params.push(opts.connectorId, userId);
  }
  if (opts.status) {
    sql += ` AND status = ?`;
    params.push(opts.status);
  }
  sql += ` ORDER BY started_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/** Recent audit events for the frontend activity feed. */
export function listAuditEvents(userId: string, limit = 50) {
  return db
    .prepare(
      `SELECT event, connector_id, sync_id, request_id, detail, created_at
       FROM tally_audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(userId, Math.min(limit, 200));
}
