import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { getWConnectorByPublicId } from "../../../db/storesWhizunik.js";

const DEFAULT_JWT_SECRET = "change-me-to-a-random-secret-in-production";

function jwtSecret(): string {
  const configured = (process.env.JWT_SECRET || "").trim();
  if (!configured || configured === DEFAULT_JWT_SECRET) {
    if (process.env.NODE_ENV === "production") {
      // Fail fast: running production on the default/empty secret silently
      // invalidates every connector token on each deploy and is a security
      // hole. Set JWT_SECRET to a strong random value (openssl rand -hex 32).
      throw new Error(
        "JWT_SECRET is not set (or is the default placeholder). Set a strong random JWT_SECRET in production — see ecosystem.config.cjs."
      );
    }
    if (!configured) {
      console.warn("[whizunik][auth] JWT_SECRET not set — using the insecure development default. Never use this in production.");
    }
    return DEFAULT_JWT_SECRET;
  }
  return configured;
}

export interface AccessClaims {
  connectorId: string;
  deviceId: string;
  tenantId: string;
  typ: "access";
}

export interface RefreshClaims {
  connectorId: string;
  deviceId: string;
  tenantId: string;
  typ: "refresh";
}

export const ACCESS_TTL_SECONDS = 60 * 60; // 1h
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d

export function signAccessToken(connectorId: string, deviceId: string, tenantId: string): { token: string; expiresAt: string } {
  const token = jwt.sign({ connectorId, deviceId, tenantId, typ: "access" }, jwtSecret(), {
    expiresIn: ACCESS_TTL_SECONDS,
  });
  return { token, expiresAt: new Date(Date.now() + ACCESS_TTL_SECONDS * 1000).toISOString() };
}

export function signRefreshToken(connectorId: string, deviceId: string, tenantId: string): string {
  return jwt.sign({ connectorId, deviceId, tenantId, typ: "refresh" }, jwtSecret(), {
    expiresIn: REFRESH_TTL_SECONDS,
  });
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Verify a Bearer access token. Returns claims or throws with code. */
export function verifyAccessToken(token: string): AccessClaims {
  try {
    const payload = jwt.verify(token, jwtSecret()) as AccessClaims & { exp?: number };
    if (payload.typ !== "access") {
      const err = new Error("wrong token type") as Error & { code?: string };
      err.code = "AUTHENTICATION_FAILED";
      throw err;
    }
    return payload;
  } catch (e: unknown) {
    const err = e as Error & { name?: string; code?: string };
    if (err?.name === "TokenExpiredError") {
      const expired = new Error("Access token expired") as Error & { code?: string };
      expired.code = "TOKEN_EXPIRED";
      throw expired;
    }
    const failed = new Error("Invalid access token") as Error & { code?: string; cause?: unknown };
    failed.code = "AUTHENTICATION_FAILED";
    failed.cause = e;
    throw failed;
  }
}

export function verifyRefreshToken(token: string): RefreshClaims {
  try {
    const payload = jwt.verify(token, jwtSecret()) as RefreshClaims;
    if (payload.typ !== "refresh") {
      const err = new Error("wrong token type") as Error & { code?: string };
      err.code = "AUTHENTICATION_FAILED";
      throw err;
    }
    return payload;
  } catch (e: unknown) {
    const err = e as Error & { name?: string };
    if (err?.name === "TokenExpiredError") {
      const expired = new Error("Refresh token expired") as Error & { code?: string };
      expired.code = "TOKEN_EXPIRED";
      throw expired;
    }
    const failed = new Error("Invalid refresh token") as Error & { code?: string; cause?: unknown };
    failed.code = "AUTHENTICATION_FAILED";
    failed.cause = e;
    throw failed;
  }
}

// ---------------------------------------------------------------------------
// Exact-spec error envelope: { "error": { "code", "message" } }
// Always JSON Content-Type (express .json does this).
// ---------------------------------------------------------------------------

export type WzErrorCode =
  | "INVALID_PAYLOAD"
  | "AUTHENTICATION_FAILED"
  | "INVALID_COMPANY"
  | "TOKEN_EXPIRED"
  | "RATE_LIMITED"
  | "SERVER_ERROR";

const STATUS_FOR_CODE: Record<WzErrorCode, number> = {
  INVALID_PAYLOAD: 400,
  AUTHENTICATION_FAILED: 401,
  INVALID_COMPANY: 404,
  TOKEN_EXPIRED: 401,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
};

export function sendWzError(res: Response, code: WzErrorCode, message: string): void {
  res.status(STATUS_FOR_CODE[code]).json({ error: { code, message } });
}

export async function wzAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    sendWzError(res, "AUTHENTICATION_FAILED", "Missing or invalid Authorization header");
    return;
  }
  const token = header.slice(7).trim();
  if (!token) {
    sendWzError(res, "AUTHENTICATION_FAILED", "Missing access token");
    return;
  }
  try {
    const claims = verifyAccessToken(token);
    // Disconnected devices stop here: a revoked connector's JWT is dead
    // immediately, not just at the next refresh.
    try {
      const row = await getWConnectorByPublicId(claims.connectorId);
      if (!row || row.status !== "active") {
        sendWzError(res, "AUTHENTICATION_FAILED", "Connector has been revoked");
        return;
      }
    } catch {
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      return;
    }
    (req as Request & { wzClaims?: AccessClaims }).wzClaims = claims;
    next();
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code === "TOKEN_EXPIRED" ? "TOKEN_EXPIRED" : "AUTHENTICATION_FAILED";
    sendWzError(res, code as WzErrorCode, (e as Error)?.message || "Authentication failed");
  }
}

/** Accept X-Request-Id for tracing: echo it back when present. */
export function traceRequestId(req: Request, res: Response, next: NextFunction): void {
  const rid = req.headers["x-request-id"];
  if (typeof rid === "string" && rid.length > 0 && rid.length <= 128) {
    res.setHeader("X-Request-Id", rid);
  }
  next();
}

/** Optional HTTPS enforcement (production reverse proxy terminates TLS). */
export function requireHttpsIfConfigured(req: Request, res: Response, next: NextFunction): void {
  if (process.env.REQUIRE_HTTPS === "true") {
    const proto = (req.headers["x-forwarded-proto"] as string) || (req.secure ? "https" : "http");
    if (proto !== "https") {
      sendWzError(res, "AUTHENTICATION_FAILED", "HTTPS is required");
      return;
    }
  }
  next();
}

// ---------------------------------------------------------------------------
// Tiny in-memory sliding-window limiter returning the exact-spec shape.
// ---------------------------------------------------------------------------

const wzBuckets = new Map<string, number[]>();

export function wzRateLimit(windowMs: number, max: number, keyFn: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const now = Date.now();
    let hits = wzBuckets.get(key);
    if (!hits) {
      hits = [];
      wzBuckets.set(key, hits);
    }
    const fresh = hits.filter((t) => now - t < windowMs);
    fresh.push(now);
    wzBuckets.set(key, fresh);
    if (fresh.length > max) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - fresh[0])) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      sendWzError(res, "RATE_LIMITED", "Too many requests — retry later");
      return;
    }
    if (wzBuckets.size > 5000) {
      for (const [k, v] of wzBuckets) {
        if (v.length === 0 || now - v[v.length - 1] > windowMs) wzBuckets.delete(k);
      }
    }
    next();
  };
}

export function resetWzRateLimits(): void {
  wzBuckets.clear();
}
