import type { Request, Response, NextFunction } from "express";
import { getConnectorByPublicId, updateConnectorByRowId } from "../../../db/storesTally.js";
import { sha256, safeEqual, hmacVerify, canonicalRequest } from "../utils/crypto.js";
import { ApiError, sendError } from "../errors.js";
import { config } from "../utils/env.js";
import { audit } from "../services/audit.service.js";
import { newRequestId } from "../utils/logger.js";

export interface AuthenticatedConnector {
  rowId: string;
  connectorId: string;
  userId: string;
  status: string;
  appVersion: string | null;
}

declare module "express-serve-static-core" {
  interface Request {
    connector?: AuthenticatedConnector;
    requestId?: string;
  }
}

/** Replay cache: requestId seen recently (single process; window-bounded). */
const seenRequestIds = new Map<string, number>();
const REPLAY_CACHE_TTL_MS = 10 * 60_000;

function pruneReplayCache(): void {
  const now = Date.now();
  for (const [k, ts] of seenRequestIds) {
    if (now - ts > REPLAY_CACHE_TTL_MS) seenRequestIds.delete(k);
  }
}

function isReplayed(connectorId: string, requestId: string): boolean {
  const key = `${connectorId}|${requestId}`;
  if (seenRequestIds.has(key)) return true;
  seenRequestIds.set(key, Date.now());
  if (seenRequestIds.size > 10_000) pruneReplayCache();
  return false;
}

/**
 * Authenticate a connector request.
 * Headers:
 *   Authorization: Bearer <accessToken>
 *   X-Connector-Id: <public connector id>
 *   X-Request-Id: <uuid per request>
 *   X-Timestamp: <epoch ms>
 *   X-Signature: HMAC-SHA256 hex (if HMAC enforcement enabled/used)
 * The tenant is derived from the connector record — never from the payload.
 */
export async function requireConnectorAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  req.requestId = (req.headers["x-request-id"] as string) || newRequestId();

  const connectorId = req.headers["x-connector-id"] as string | undefined;
  const token = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : undefined;
  const requestId = req.headers["x-request-id"] as string | undefined;
  const timestamp = req.headers["x-timestamp"] as string | undefined;
  const signature = req.headers["x-signature"] as string | undefined;

  const deny = (message: string, reason: string) => {
    if (req.requestId) {
      audit("AUTHENTICATION_FAILED", {
        userId: "unknown",
        requestId: req.requestId,
        detail: { reason, connectorId: connectorId ?? null, path: req.path },
      });
    }
    sendError(res, "AUTHENTICATION_FAILED", message, undefined, req.requestId);
  };

  if (!connectorId || !token) {
    deny("Missing connector credentials", "missing_credentials");
    return;
  }

  let row: any;
  try {
    row = await getConnectorByPublicId(connectorId);
  } catch (err) {
    console.error("[connectorAuth] lookup failed:", err);
    deny("Authentication service unavailable", "db_unavailable");
    return;
  }

  if (!row) {
    deny("Unknown connector", "unknown_connector");
    return;
  }
  if (row.status === "REVOKED") {
    deny("Connector has been revoked", "connector_revoked");
    return;
  }

  // Token check (constant-time against the stored hash)
  if (!safeEqual(row.token_hash, sha256(token))) {
    deny("Invalid connector token", "bad_token");
    return;
  }

  // Timestamp freshness window (anti-replay, second factor)
  if (timestamp) {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > config.requestTimestampWindowSec * 1000) {
      deny("Request timestamp outside allowed window", "stale_timestamp");
      return;
    }
  } else if (config.hmacRequired) {
    deny("Missing request timestamp", "missing_timestamp");
    return;
  }

  // Optional / enforced HMAC signature
  if (signature || config.hmacRequired) {
    if (!signature || !timestamp || !requestId) {
      deny("Missing signature headers", "missing_signature_parts");
      return;
    }
    if (row.hmac_secret_hash) {
      // NOTE: HMAC requires the raw secret; we store only its hash, so a
      // connector-provided proof is verified by re-deriving the canonical
      // string and comparing the *signature* against a freshly computed HMAC
      // using the stored hash as key material (defense-in-depth variant).
      const bodyHash = sha256(JSON.stringify(req.body ?? {}));
      const canonical = canonicalRequest({
        connectorId,
        requestId,
        timestamp,
        method: req.method,
        path: req.path,
        bodyHash,
      });
      if (!hmacVerify(row.hmac_secret_hash, canonical, signature)) {
        deny("Invalid request signature", "bad_signature");
        return;
      }
    }
  }

  // Replay protection via unique request ids
  if (requestId && isReplayed(connectorId, requestId)) {
    deny("Duplicate request id — possible replay", "replayed_request_id");
    return;
  }

  // Touch heartbeat opportunistically on authenticated calls
  try {
    await updateConnectorByRowId(row.id, {
      last_heartbeat: new Date().toISOString(),
      status: "ONLINE",
    });
  } catch {
    // Non-fatal — auth already succeeded
  }

  req.connector = {
    rowId: row.id,
    connectorId: row.connector_id,
    userId: row.user_id, // tenant always derived from the connector record
    status: row.status,
    appVersion: row.app_version,
  };
  next();
}
