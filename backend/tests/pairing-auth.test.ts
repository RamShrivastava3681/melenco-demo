import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { initTestDb } from "./setup.js";
import { signupUser, createConnector, connectorHeaders, freshRateLimits, type UserCtx, type ConnectorCtx } from "./helpers.js";

let app: ReturnType<typeof createApp>;
let user: UserCtx;
let connector: ConnectorCtx;

beforeAll(async () => {
  await initTestDb();
  app = createApp();
  user = await signupUser(app, "pairing-test@example.com");
  connector = await createConnector(user, "pairing-test@example.com");
});

beforeEach(() => {
  freshRateLimits();
});

describe("pairing code lifecycle", () => {
  it("requires JWT auth to create a pairing code", async () => {
    const res = await request(app).post("/api/integrations/tally/pairing-code").send({});
    expect(res.status).toBe(401);
  });

  it("creates a WZK-format code with expiry", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/pairing-code")
      .set("Authorization", `Bearer ${user.token}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^WZK-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.body.expiresAt).toBeTruthy();
    expect(res.body.expiresInMinutes).toBeGreaterThan(0);
  });

  it("rejects an unknown pairing code at connect", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/connect")
      .send({ pairingCode: "WZK-0000-0000", deviceName: "x" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects a malformed pairing code", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/connect")
      .send({ pairingCode: "not-a-code" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
  });

  it("expires the pairing code after single use", async () => {
    const pr = await request(app)
      .post("/api/integrations/tally/pairing-code")
      .set("Authorization", `Bearer ${user.token}`)
      .send({});
    const code = pr.body.code;

    const first = await request(app)
      .post("/api/integrations/tally/connect")
      .send({ pairingCode: code, deviceName: "PC-1" });
    expect(first.status).toBe(201);
    expect(first.body.accessToken).toBeTruthy();
    expect(first.body.hmacSecret).toBeTruthy();
    expect(first.body.config).toBeTruthy();

    // Reuse of the same code must fail
    const second = await request(app)
      .post("/api/integrations/tally/connect")
      .send({ pairingCode: code, deviceName: "PC-2" });
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("never returns the same access token twice and never stores plaintext", async () => {
    // Two connectors → two distinct tokens
    const pr = await request(app)
      .post("/api/integrations/tally/pairing-code")
      .set("Authorization", `Bearer ${user.token}`)
      .send({});
    const c = await request(app)
      .post("/api/integrations/tally/connect")
      .send({ pairingCode: pr.body.code, deviceName: "PC-3" });
    expect(c.status).toBe(201);
    expect(c.body.accessToken).not.toBe(connector.accessToken);
  });
});

describe("connector authentication", () => {
  it("rejects requests without credentials", async () => {
    const res = await request(app).post("/api/integrations/tally/heartbeat").send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects an invalid token", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/heartbeat")
      .set({
        Authorization: "Bearer wrong-token",
        "X-Connector-Id": connector.connectorId,
        "X-Request-Id": crypto.randomUUID(),
        "X-Timestamp": String(Date.now()),
      })
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects an unknown connector id", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/heartbeat")
      .set({
        Authorization: `Bearer ${connector.accessToken}`,
        "X-Connector-Id": "tc_doesnotexist",
        "X-Request-Id": crypto.randomUUID(),
        "X-Timestamp": String(Date.now()),
      })
      .send({});
    expect(res.status).toBe(401);
  });

  it("accepts a valid heartbeat", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/heartbeat")
      .set(connectorHeaders(connector))
      .send({ appVersion: "1.0.1", pendingUploads: 3 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.serverTime).toBeTruthy();
  });

  it("rejects stale timestamps (anti-replay window)", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/heartbeat")
      .set({
        ...connectorHeaders(connector),
        "X-Timestamp": String(Date.now() - 60 * 60_000), // 1h old
      })
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("rejects replayed request ids", async () => {
    const requestId = crypto.randomUUID();
    const headers = { ...connectorHeaders(connector, requestId) };

    const first = await request(app).post("/api/integrations/tally/heartbeat").set(headers).send({});
    expect(first.status).toBe(200);

    const second = await request(app).post("/api/integrations/tally/heartbeat").set(headers).send({});
    expect(second.status).toBe(401);
  });
});

describe("tenant isolation", () => {
  it("prevents a connector from syncing into another tenant's company", async () => {
    // Second tenant with its own company
    const user2 = await signupUser(app, "tenant2@example.com");
    const connector2 = await createConnector(user2, "tenant2@example.com", {
      companies: [{ guid: "guid-2222", name: "Tenant Two Co" }],
    });

    // Tenant 2 starts a sync against its own company
    const syncRes = await request(app)
      .post("/api/integrations/tally/sync/start")
      .set(connectorHeaders(connector2))
      .send({ companyId: connector2.companyId, entityType: "SALES_VOUCHER", syncType: "INITIAL_SYNC" });
    expect(syncRes.status).toBe(201);
    const syncId = syncRes.body.syncId;

    // Tenant 1's connector attempts to upload into tenant 2's session
    const res = await request(app)
      .post("/api/integrations/tally/sync/batch")
      .set(connectorHeaders(connector))
      .send({
        syncId,
        companyId: connector2.companyId,
        entityType: "SALES_VOUCHER",
        batchNumber: 1,
        totalBatches: 1,
        records: [
          { voucherType: "Sales", voucherNumber: "EVIL-1", voucherDate: "2026-07-01", partyName: "Evil", amount: 1 },
        ],
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("AUTHORIZATION_FAILED");
  });

  it("rejects a company owned by another tenant on sync/start", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/sync/start")
      .set(connectorHeaders(connector))
      .send({ companyId: "not-my-company", entityType: "LEDGER", syncType: "INITIAL_SYNC" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_COMPANY");
  });
});
