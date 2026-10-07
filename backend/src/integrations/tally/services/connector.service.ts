import { v4 as uuidv4 } from "uuid";
import {
  getConnectorByRowId as getByRow,
  getConnectorByPublicId as getByPublic,
  listConnectorsForUser as listForUser,
  connectorPublicIdExists,
  createConnectorRow,
  updateConnectorByRowId,
} from "../../../db/storesTally.js";
import { generateToken, sha256 } from "../utils/crypto.js";
import { ApiError } from "../errors.js";
import { config } from "../utils/env.js";
import { publicApiBaseUrl } from "../whizunik/baseUrl.js";
import { audit } from "./audit.service.js";
import type { DbItem } from "../../../db/dynamo.js";

export interface ConnectorRow extends DbItem {
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
export async function registerConnector(params: {
  userId: string;
  pairingCodeId: string;
  connectorName?: string;
  deviceName?: string;
  deviceId?: string;
  appVersion?: string;
  requestId?: string;
}): Promise<{ connector: ConnectorRow; credentials: ConnectorCredentials }> {
  const accessToken = generateToken(32);
  const hmacSecret = generateToken(24);

  // Public connector id must be globally unique — retry on collision (paranoid).
  let connectorId = newConnectorId();
  for (let i = 0; i < 3; i++) {
    const clash = await connectorPublicIdExists(connectorId);
    if (!clash) break;
    connectorId = newConnectorId();
  }

  const id = uuidv4();
  await createConnectorRow({
    id,
    user_id: params.userId,
    connector_id: connectorId,
    connector_name: params.connectorName || "Tally Connector",
    status: "ONLINE",
    device_name: params.deviceName || null,
    device_id: params.deviceId || null,
    app_version: params.appVersion || null,
    token_hash: sha256(accessToken),
    hmac_secret_hash: sha256(hmacSecret),
    pairing_code_id: params.pairingCodeId,
  });

  const connector = (await getByRow(id)) as ConnectorRow;

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
      apiBaseUrl: publicApiBaseUrl(),
      heartbeatIntervalSeconds: Math.max(30, Math.floor(config.heartbeatStaleMinutes * 60 / 3)),
    },
  };
}

export async function getConnectorByRowId(rowId: string): Promise<ConnectorRow | undefined> {
  return (await getByRow(rowId)) as ConnectorRow | undefined;
}

export async function getConnectorByPublicId(connectorId: string): Promise<ConnectorRow | undefined> {
  return (await getByPublic(connectorId)) as ConnectorRow | undefined;
}

export async function listConnectorsForUser(userId: string): Promise<ConnectorRow[]> {
  return (await listForUser(userId)) as ConnectorRow[];
}

/** Record a heartbeat; keeps the connector ONLINE. */
export async function touchHeartbeat(rowId: string, appVersion?: string): Promise<void> {
  const row = await getByRow(rowId);
  if (!row) return;
  await updateConnectorByRowId(rowId, {
    last_heartbeat: new Date().toISOString(),
    ...(appVersion ? { app_version: appVersion } : {}),
    status: "ONLINE",
  });
}

/** Update sync timestamps after a session finishes. */
export async function markSync(rowId: string, successful: boolean): Promise<void> {
  const now = new Date().toISOString();
  if (successful) {
    await updateConnectorByRowId(rowId, { last_sync: now, last_successful_sync: now });
  } else {
    await updateConnectorByRowId(rowId, { last_sync: now });
  }
}

/** Revoke a connector — permanently blocks authentication. */
export async function revokeConnector(userId: string, connectorRowId: string, requestId?: string): Promise<void> {
  const row = await getByRow(connectorRowId);
  const connector = row && row.user_id === userId ? (row as ConnectorRow) : undefined;
  if (!connector) {
    throw new ApiError("AUTHORIZATION_FAILED", "Connector not found for this account");
  }
  await updateConnectorByRowId(connectorRowId, {
    status: "REVOKED",
    revoked_at: new Date().toISOString(),
  });
  audit("CONNECTOR_REVOKED", { userId, connectorId: connector.connector_id, requestId });
}

/** True when a connector's heartbeat is recent enough to be considered online. */
export function isHeartbeatFresh(connector: ConnectorRow): boolean {
  if (!connector.last_heartbeat) return false;
  const last = new Date(connector.last_heartbeat.endsWith("Z") ? connector.last_heartbeat : connector.last_heartbeat + "Z").getTime();
  return Date.now() - last < config.heartbeatStaleMinutes * 60_000;
}
