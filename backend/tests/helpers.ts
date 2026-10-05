import request from "supertest";
import type { Express } from "express";
import db from "../src/db/index.js";
import { createApp } from "../src/app.js";
import { resetRateLimiters } from "../src/integrations/tally/middleware/rateLimiter.js";

export interface UserCtx {
  app: Express;
  token: string;
  userId: string;
}

export interface ConnectorCtx {
  connectorId: string;
  accessToken: string;
  hmacSecret: string;
  companyId: string;
}

export async function signupUser(app: Express, email: string): Promise<UserCtx> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "password123", name: "Test User" });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  return { app, token: res.body.token, userId: res.body.user.id };
}

export async function createConnector(
  user: UserCtx,
  email: string,
  opts: { companies?: Array<{ guid: string; name: string }> } = {}
): Promise<ConnectorCtx> {
  // 1. Pairing code (frontend, JWT)
  const pr = await request(user.app)
    .post("/api/integrations/tally/pairing-code")
    .set("Authorization", `Bearer ${user.token}`)
    .send({});
  if (pr.status !== 201) throw new Error(`pairing failed: ${JSON.stringify(pr.body)}`);

  // 2. Connect (connector, no auth yet)
  const cr = await request(user.app)
    .post("/api/integrations/tally/connect")
    .send({
      pairingCode: pr.body.code,
      connectorName: "Test Connector",
      deviceName: "CI-PC",
      deviceId: `dev-${email}`,
      appVersion: "1.0.0",
      companies: opts.companies ?? [{ guid: "guid-1111", name: "Test Company Ltd" }],
    });
  if (cr.status !== 201) throw new Error(`connect failed: ${JSON.stringify(cr.body)}`);

  return {
    connectorId: cr.body.connectorId,
    accessToken: cr.body.accessToken,
    hmacSecret: cr.body.hmacSecret,
    companyId: cr.body.companies[0].id,
  };
}

/** Standard connector auth headers. */
export function connectorHeaders(ctx: ConnectorCtx, requestId?: string) {
  return {
    Authorization: `Bearer ${ctx.accessToken}`,
    "X-Connector-Id": ctx.connectorId,
    "X-Request-Id": requestId ?? crypto.randomUUID(),
    "X-Timestamp": String(Date.now()),
  };
}

export async function startSync(
  user: UserCtx,
  ctx: ConnectorCtx,
  entityType = "SALES_VOUCHER",
  syncType = "INITIAL_SYNC"
): Promise<string> {
  // Test isolation: cancel leftover active sessions for this connector+entity
  // so tests don't block each other (production concurrency rules still apply
  // within a test — see the "prevents concurrent duplicate sessions" test).
  db.prepare(
    `UPDATE tally_sync_sessions SET status = 'CANCELLED', completed_at = datetime('now')
     WHERE connector_id = (SELECT id FROM tally_connectors WHERE connector_id = ?)
       AND entity_type = ? AND status IN ('PENDING','RUNNING')`
  ).run(ctx.connectorId, entityType);

  const res = await request(user.app)
    .post("/api/integrations/tally/sync/start")
    .set(connectorHeaders(ctx))
    .send({ companyId: ctx.companyId, entityType, syncType });
  if (res.status !== 201) throw new Error(`sync/start failed: ${JSON.stringify(res.body)}`);
  return res.body.syncId;
}

/** Fresh limiter state for a test file. */
export function freshRateLimits(): void {
  resetRateLimiters();
}

export function salesVoucher(i: number, overrides: Record<string, unknown> = {}) {
  return {
    voucherType: "Sales",
    voucherNumber: `INV-${String(i).padStart(5, "0")}`,
    voucherDate: "2026-07-01",
    partyName: "Acme Traders",
    amount: 1000 + i,
    data: { dueDate: "2026-08-01", narration: `Test sale ${i}` },
    ...overrides,
  };
}

export function ledgerRecord(name: string, opts: Record<string, unknown> = {}) {
  return {
    partyName: name,
    data: { name, ...opts },
  };
}
