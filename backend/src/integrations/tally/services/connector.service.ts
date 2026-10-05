import { v4 as uuidv4 } from "uuid";
import db from "../../../db/index.js";
import { generateToken, sha256 } from "../utils/crypto.js";
import { ApiError } from "../errors.js";
import { config } from "../utils/env.js";
import { audit } from "./audit.service.js";

export interface ConnectorRow {
  id: string;
  user_id: string;
  connector_id: string;
  connector_name: string;
  status: "PENDING" | "ONLINE" | "OFFLINE" | "REVOKED";
  device_name: string | null;
  device_id: string | null;
  app_version: string | null;
  token_hash: string;
  hmac_secret_hash: string | null;
  last_heartbeat: string | null;
  last_sync: string | null;
  last_successful_sync: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface ConnectorCredentials {
  connectorId: string;
  accessToken: string; // plaintext, shown once
  hmacSecret: string; // plaintext, shown once
  apiBaseUrl: string;
  heartbeatIntervalSeconds: number;
}

/** Public connector id: tc_ + short random, unique across all tenants. */
function newConnectorId(): string {
  return `tc_${generateToken(12)}`;
}

/**
 * Register a new connector for a tenant after successful pairing.
 * Plaintext credentials are returned exactly once; only hashes are stored.
 */
export function registerConnector(params: {
  userId: string;
  pairingCodeId: string;
  connectorName?: string;
  deviceName?: string;
  deviceId?: string;
  appVersion?: string;
  requestId?: string;
}): { connector: ConnectorRow; credentials: ConnectorCredentials } {
  const accessToken = generateToken(32);
  const hmacSecret = generateToken(24);

  // Public connector id must be globally unique — retry on collision (paranoid).
  let connectorId = newConnectorId();
  for (let i = 0; i < 3; i++) {
    const clash = db.prepare(`SELECT id FROM tally_connectors WHERE connector_id = ?`).get(connectorId);
    if (!clash) break;
    connectorId = newConnectorId();
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO tally_connectors
       (id, user_id, connector_id, connector_name, status, device_name, device_id, app_version,
        token_hash, hmac_secret_hash, pairing_code_id)
     VALUES (?, ?, ?, ?, 'ONLINE', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.userId,
    connectorId,
    params.connectorName || "Tally Connector",
    params.deviceName || null,
    params.deviceId || null,
    params.appVersion || null,
    sha256(accessToken),
    sha256(hmacSecret),
    params.pairingCodeId
  );

  const connector = getConnectorByRowId(id)!;

  audit("CONNECTOR_CONNECTED", {
    userId: params.userId,
    connectorId,
    requestId: params.requestId,
    detail: { deviceName: params.deviceName || null, appVersion: params.appVersion || null },
  });

  return {
    connector,
    credentials: {
      connectorId,
      accessToken,
      hmacSecret,
      apiBaseUrl: process.env.PUBLIC_API_BASE_URL || "",
      heartbeatIntervalSeconds: Math.max(30, Math.floor(config.heartbeatStaleMinutes * 60 / 3)),
    },
  };
}

export function getConnectorByRowId(rowId: string): ConnectorRow | undefined {
  return db
    .prepare(`SELECT * FROM tally_connectors WHERE id = ?`)
    .get(rowId) as ConnectorRow | undefined;
}

export function getConnectorByPublicId(connectorId: string): ConnectorRow | undefined {
  return db
    .prepare(`SELECT * FROM tally_connectors WHERE connector_id = ?`)
    .get(connectorId) as ConnectorRow | undefined;
}

export function listConnectorsForUser(userId: string): ConnectorRow[] {
  return db
    .prepare(
      `SELECT * FROM tally_connectors WHERE user_id = ? AND status != 'REVOKED' ORDER BY created_at DESC`
    )
    .all(userId) as ConnectorRow[];
}

/** Record a heartbeat; keeps the connector ONLINE. */
export function touchHeartbeat(rowId: string, appVersion?: string): void {
  db.prepare(
    `UPDATE tally_connectors
     SET last_heartbeat = datetime('now'),
         app_version = COALESCE(?, app_version),
         status = 'ONLINE',
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(appVersion || null, rowId);
}

/** Update sync timestamps after a session finishes. */
export function markSync(rowId: string, successful: boolean): void {
  if (successful) {
    db.prepare(
      `UPDATE tally_connectors
       SET last_sync = datetime('now'), last_successful_sync = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(rowId);
  } else {
    db.prepare(
      `UPDATE tally_connectors SET last_sync = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(rowId);
  }
}

/** Revoke a connector — permanently blocks authentication. */
export function revokeConnector(userId: string, connectorRowId: string, requestId?: string): void {
  const connector = db
    .prepare(`SELECT * FROM tally_connectors WHERE id = ? AND user_id = ?`)
    .get(connectorRowId, userId) as ConnectorRow | undefined;
  if (!connector) {
    throw new ApiError("AUTHORIZATION_FAILED", "Connector not found for this account");
  }
  db.prepare(
    `UPDATE tally_connectors
     SET status = 'REVOKED', revoked_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  ).run(connectorRowId);
  audit("CONNECTOR_REVOKED", { userId, connectorId: connector.connector_id, requestId });
}

/** True when a connector's heartbeat is recent enough to be considered online. */
export function isHeartbeatFresh(connector: ConnectorRow): boolean {
  if (!connector.last_heartbeat) return false;
  const last = new Date(connector.last_heartbeat.endsWith("Z") ? connector.last_heartbeat : connector.last_heartbeat + "Z").getTime();
  return Date.now() - last < config.heartbeatStaleMinutes * 60_000;
}
