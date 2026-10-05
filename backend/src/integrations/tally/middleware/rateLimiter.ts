import type { Request, Response, NextFunction } from "express";
import { sendError } from "../errors.js";

/**
 * Lightweight sliding-window rate limiter (single-process, in-memory —
 * matches the sql.js single-instance deployment model).
 * Buckets key on connector id when available, otherwise client IP.
 */

interface Bucket {
  hits: number[];
}

const buckets = new Map<string, Bucket>();

function pruneBucket(b: Bucket, windowMs: number, now: number): number[] {
  b.hits = b.hits.filter((ts) => now - ts < windowMs);
  return b.hits;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyBy?: "connector" | "ip";
  scope: string;
}

/** Create a rate-limiting middleware. */
export function createRateLimiter(opts: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keyPart =
      opts.keyBy === "ip"
        ? req.ip || "unknown-ip"
        : (req.headers["x-connector-id"] as string) || req.ip || "unknown";
    const key = `${opts.scope}|${keyPart}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      buckets.set(key, bucket);
    }
    pruneBucket(bucket, opts.windowMs, now);

    if (bucket.hits.length >= opts.max) {
      const oldest = bucket.hits[0];
      const retryAfterSec = Math.max(1, Math.ceil((opts.windowMs - (now - oldest)) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      sendError(res, "RATE_LIMITED", "Too many requests — retry later", {
        scope: opts.scope,
        retryAfterSeconds: retryAfterSec,
      });
      return;
    }

    bucket.hits.push(now);

    // Occasional global cleanup to bound memory
    if (buckets.size > 5_000) {
      for (const [k, v] of buckets) {
        if (pruneBucket(v, opts.windowMs, now).length === 0) buckets.delete(k);
      }
    }

    next();
  };
}

/** Test-only: clear all buckets between test suites. */
export function resetRateLimiters(): void {
  buckets.clear();
}

import { config } from "../utils/env.js";

/** Pre-built limiters for each endpoint class. */
export const rateLimiters = {
  connect: createRateLimiter({
    scope: "connect",
    keyBy: "ip",
    windowMs: 60 * 60_000,
    max: config.rateLimitConnectPerHour,
  }),
  pairing: createRateLimiter({
    scope: "pairing",
    keyBy: "ip",
    windowMs: 10 * 60_000,
    max: config.rateLimitPairingPer10Min,
  }),
  heartbeat: createRateLimiter({
    scope: "heartbeat",
    keyBy: "connector",
    windowMs: 60_000,
    max: config.rateLimitHeartbeatPerMin,
  }),
  batch: createRateLimiter({
    scope: "batch",
    keyBy: "connector",
    windowMs: 60_000,
    max: config.rateLimitBatchPerMin,
  }),
  default: createRateLimiter({
    scope: "default",
    keyBy: "connector",
    windowMs: 60_000,
    max: config.rateLimitDefaultPerMin,
  }),
};
