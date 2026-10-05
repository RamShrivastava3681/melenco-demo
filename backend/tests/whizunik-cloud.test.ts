import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { initTestDb } from "./setup.js";
import { signupUser, freshRateLimits, type UserCtx } from "./helpers.js";
import { resetWzRateLimits } from "../src/integrations/tally/whizunik/auth.js";

let app: ReturnType<typeof createApp>;
let user: UserCtx;

const DEVICE_ID = "123e4567-e89b-12d3-a456-426614174000";

async function createPairingCode(authToken: string, body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/integrations/tally/admin/pairing-codes")
    .set("Authorization", `Bearer ${authToken}`)
    .send({ tenantName: "Tenant Name", companyName: "Demo Company", ...body });
  return res;
}

function connectBody(pairingCode: string, overrides: Record<string, unknown> = {}) {
  return {
    pairingCode,
    deviceId: DEVICE_ID,
    deviceName: "DESKTOP-ABC",
    appVersion: "1.0.0",
    protocolVersion: "1.0",
    company: { name: "Demo Company", tallyGuid: "tally-guid-1" },
    ...overrides,
  };
}

beforeAll(async () => {
  await initTestDb();
  app = createApp();
  user = await signupUser(app, "whizunik-cloud@example.com");
});

beforeEach(() => {
  freshRateLimits();
  resetWzRateLimits();
});

describe("WhizUnik Cloud API — exact 5-endpoint spec", () => {
  it("admin creates a WZK-XXXX-XXXX pairing code linked to tenant + company", async () => {
    const res = await createPairingCode(user.token, { tenantId: "tenant-1" });
    expect(res.status).toBe(201);
    expect(res.body.pairingCode).toMatch(/^WZK-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.body.tenantId).toBe("tenant-1");
    expect(res.body.expiresAt).toBeTruthy();
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("1. POST /connect exchanges a pairing code for tokens (200, exact shape)", async () => {
    const pc = await createPairingCode(user.token, { tenantId: "tenant-connect" });
    const res = await request(app)
      .post("/api/integrations/tally/connect")
      .send(connectBody(pc.body.pairingCode));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.connectorId).toBeTruthy();
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.accessTokenExpiresAt).toBeTruthy();
    expect(res.body.tenant.id).toBe("tenant-connect");
    expect(res.body.tenant.name).toBeTruthy();
    expect(res.body.companyMapping.whizunikCompanyId).toBeTruthy();
    expect(res.body.companyMapping.tallyCompanyGuid).toBe("tally-guid-1");
  });

  it("1. POST /connect rejects malformed pairing codes (400 INVALID_PAYLOAD)", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/connect")
      .send(connectBody("not-a-code"));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
  });

  it("1. POST /connect rejects unknown codes (401 AUTHENTICATION_FAILED)", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/connect")
      .send(connectBody("WZK-ZZZZ-9999"));
    // WZK-ZZZZ-9999 matches regex charset? Z,Z,Z,Z + 9999 → valid format, unknown code
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("1. POST /connect rejects reused codes (single-use)", async () => {
    const pc = await createPairingCode(user.token, { tenantId: "tenant-reuse" });
    const first = await request(app).post("/api/integrations/tally/connect").send(connectBody(pc.body.pairingCode));
    expect(first.status).toBe(200);
    const second = await request(app).post("/api/integrations/tally/connect").send(connectBody(pc.body.pairingCode));
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("2. POST /token refreshes the access token (same shape, new token)", async () => {
    const pc = await createPairingCode(user.token, { tenantId: "tenant-token" });
    const c = await request(app).post("/api/integrations/tally/connect").send(connectBody(pc.body.pairingCode));
    expect(c.status).toBe(200);
    const res = await request(app).post("/api/integrations/tally/token").send({
      refreshToken: c.body.refreshToken,
      deviceId: DEVICE_ID,
      connectorId: c.body.connectorId,
    });
    expect(res.status).toBe(200);
    expect(res.body.connectorId).toBe(c.body.connectorId);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.accessTokenExpiresAt).toBeTruthy();
    expect(res.body.tenant.id).toBe("tenant-token");
    expect(res.body.companyMapping.whizunikCompanyId).toBe(c.body.companyMapping.whizunikCompanyId);
  });

  it("2. POST /token rejects bad refresh tokens (401)", async () => {
    const pc = await createPairingCode(user.token, { tenantId: "tenant-token-bad" });
    const c = await request(app).post("/api/integrations/tally/connect").send(connectBody(pc.body.pairingCode));
    const res = await request(app).post("/api/integrations/tally/token").send({
      refreshToken: "bogus",
      deviceId: DEVICE_ID,
      connectorId: c.body.connectorId,
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("3. POST /sync/batch requires Bearer auth (401 when missing)", async () => {
    const res = await request(app).post("/api/integrations/tally/sync/batch").send({
      batchId: "b1",
      requestId: "r1",
      syncId: "s1",
      deviceId: DEVICE_ID,
      companyId: "whiz-company-1",
      entityType: "sales_voucher",
      batchNumber: 1,
      totalBatches: 1,
      records: [],
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("3. POST /sync/batch acks, dedupes on batchId/requestId, 404 on bad company", async () => {
    const pc = await createPairingCode(user.token, { tenantId: "tenant-batch" });
    const c = await request(app).post("/api/integrations/tally/connect").send(connectBody(pc.body.pairingCode));
    const auth = `Bearer ${c.body.accessToken}`;
    const companyId = c.body.companyMapping.whizunikCompanyId as string;

    const payload = (batchId: string, requestId: string) => ({
      batchId,
      requestId,
      syncId: "sync_123",
      deviceId: DEVICE_ID,
      companyId,
      entityType: "sales_voucher",
      batchNumber: 1,
      totalBatches: 10,
      records: [
        {
          source: "tally",
          sourceCompanyId: "tally-guid-1",
          entityType: "sales_voucher",
          sourceObjectId: "obj-1",
          sourceVoucherNumber: "INV-001",
          sourceVoucherDate: "2026-10-01",
          data: { amount: 100 },
        },
      ],
    });

    const first = await request(app).post("/api/integrations/tally/sync/batch").set("Authorization", auth).send(payload("sync_123_batch_00037", "req_aaa"));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ acked: true, batchId: "sync_123_batch_00037", duplicate: false, receivedCount: 1 });

    // Same batchId → duplicate, no double-insert
    const dupBatch = await request(app).post("/api/integrations/tally/sync/batch").set("Authorization", auth).send(payload("sync_123_batch_00037", "req_bbb"));
    expect(dupBatch.status).toBe(200);
    expect(dupBatch.body).toEqual({ acked: true, batchId: "sync_123_batch_00037", duplicate: true, receivedCount: 0 });

    // Same requestId (new batchId) → duplicate
    const dupReq = await request(app).post("/api/integrations/tally/sync/batch").set("Authorization", auth).send(payload("sync_123_batch_00038", "req_aaa"));
    expect(dupReq.status).toBe(200);
    expect(dupReq.body.duplicate).toBe(true);
    expect(dupReq.body.receivedCount).toBe(0);

    // Unknown company → 404 INVALID_COMPANY
    const bad = await request(app)
      .post("/api/integrations/tally/sync/batch")
      .set("Authorization", auth)
      .send({ ...payload("sync_123_batch_00039", "req_zzz"), companyId: "nope" });
    expect(bad.status).toBe(404);
    expect(bad.body.error.code).toBe("INVALID_COMPANY");
  });

  it("4. POST /heartbeat returns 204 with Bearer auth (401 without)", async () => {
    const noAuth = await request(app).post("/api/integrations/tally/heartbeat").send({
      connectorId: "x",
      deviceId: DEVICE_ID,
      appVersion: "1.0.0",
      protocolVersion: "1.0",
      status: "idle",
    });
    expect(noAuth.status).toBe(401);

    const pc = await createPairingCode(user.token, { tenantId: "tenant-hb" });
    const c = await request(app).post("/api/integrations/tally/connect").send(connectBody(pc.body.pairingCode));
    const res = await request(app)
      .post("/api/integrations/tally/heartbeat")
      .set("Authorization", `Bearer ${c.body.accessToken}`)
      .send({
        connectorId: c.body.connectorId,
        deviceId: DEVICE_ID,
        appVersion: "1.0.0",
        protocolVersion: "1.0",
        tallyVersion: "TallyPrime 4.0",
        company: "Demo Company",
        lastSync: "2026-10-05T12:00:00Z",
        currentSync: null,
        status: "idle",
      });
    expect(res.status).toBe(204);
  });

  it("5. POST /updates reports no update (exact shape)", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/updates")
      .send({ appVersion: "1.0.0", protocolVersion: "1.0" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updateAvailable: false, latestVersion: null, downloadUrl: null, notes: null });
  });

  it("serves Swagger/OpenAPI for the 5 endpoints", async () => {
    const res = await request(app).get("/api/integrations/tally/openapi.json");
    expect(res.status).toBe(200);
    for (const p of ["/api/integrations/tally/connect", "/api/integrations/tally/token", "/api/integrations/tally/sync/batch", "/api/integrations/tally/heartbeat", "/api/integrations/tally/updates"]) {
      expect(res.body.paths[p]?.post).toBeTruthy();
    }
    expect(res.body.servers?.[0]?.url).toMatch(/excel\.frillchills\.com\/api/);
  });

  it("accepts X-Request-Id for tracing on all endpoints", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/updates")
      .set("X-Request-Id", "trace-123")
      .send({ appVersion: "1.0.0", protocolVersion: "1.0" });
    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBe("trace-123");
  });

  it("GET /info advertises the excel URL, not the default", async () => {
    const res = await request(app).get("/api/integrations/tally/info");
    expect(res.status).toBe(200);
    expect(res.body.apiBaseUrl).toBe("https://excel.frillchills.com/api");
    expect(res.body.protocolVersion).toBe("1.0");
    expect(res.body.endpoints.connect).toBe("/api/integrations/tally/connect");
  });

  it("receive path: batches + records are visible to the platform", async () => {
    // Pair without an explicit tenantId so the tenant equals this user's id
    const pcRes = await request(app)
      .post("/api/integrations/tally/admin/pairing-codes")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ companyName: "Receive Co" });
    expect(pcRes.status).toBe(201);
    const c = await request(app).post("/api/integrations/tally/connect").send(connectBody(pcRes.body.pairingCode));
    expect(c.status).toBe(200);
    const auth = `Bearer ${c.body.accessToken}`;
    const companyId = c.body.companyMapping.whizunikCompanyId as string;

    const batch = await request(app).post("/api/integrations/tally/sync/batch").set("Authorization", auth).send({
      batchId: "recv_batch_001",
      requestId: "recv_req_001",
      syncId: "recv_sync_1",
      deviceId: DEVICE_ID,
      companyId,
      entityType: "sales_voucher",
      batchNumber: 1,
      totalBatches: 1,
      records: [
        { source: "tally", entityType: "sales_voucher", sourceObjectId: "o-1", sourceVoucherNumber: "INV-1", sourceVoucherDate: "2026-10-01", data: { amount: 10 } },
        { source: "tally", entityType: "sales_voucher", sourceObjectId: "o-2", sourceVoucherNumber: "INV-2", sourceVoucherDate: "2026-10-02", data: { amount: 20 } },
      ],
    });
    expect(batch.body).toEqual({ acked: true, batchId: "recv_batch_001", duplicate: false, receivedCount: 2 });

    const batches = await request(app).get("/api/integrations/tally/sync/batches").set("Authorization", `Bearer ${user.token}`);
    expect(batches.status).toBe(200);
    expect(batches.body.batches.some((b: { batch_id: string }) => b.batch_id === "recv_batch_001")).toBe(true);

    const received = await request(app)
      .get("/api/integrations/tally/received?entityType=sales_voucher&limit=10")
      .set("Authorization", `Bearer ${user.token}`);
    expect(received.status).toBe(200);
    expect(received.body.records.length).toBeGreaterThanOrEqual(2);
    expect(received.body.records[0].payload).toBeTruthy();

    // Status merges the new-spec connector/company so the platform shows it
    const status = await request(app).get("/api/integrations/tally/status").set("Authorization", `Bearer ${user.token}`);
    expect(status.status).toBe(200);
    expect(status.body.apiBaseUrl).toBe("https://excel.frillchills.com/api");
    expect(status.body.connected).toBe(true);
    expect(status.body.connectors.some((x: { connectorId: string }) => x.connectorId === c.body.connectorId)).toBe(true);
  });

  it("push path: platform queues a command, connector polls and acks it", async () => {
    const pcRes = await request(app)
      .post("/api/integrations/tally/admin/pairing-codes")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ companyName: "Push Co" });
    const c = await request(app).post("/api/integrations/tally/connect").send(connectBody(pcRes.body.pairingCode));
    const connectorAuth = `Bearer ${c.body.accessToken}`;

    // Platform pushes REQUEST_SYNC
    const push = await request(app)
      .post("/api/integrations/tally/commands")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ connectorId: c.body.connectorId, command: "REQUEST_SYNC", payload: { entityType: "sales_voucher" } });
    expect(push.status).toBe(201);
    expect(push.body.status).toBe("PENDING");

    // Connector polls outbound and gets it
    const pending = await request(app).get("/api/integrations/tally/commands/pending").set("Authorization", connectorAuth);
    expect(pending.status).toBe(200);
    expect(pending.body.commands.length).toBe(1);
    expect(pending.body.commands[0].command).toBe("REQUEST_SYNC");

    // Second poll: already delivered, queue empty
    const pending2 = await request(app).get("/api/integrations/tally/commands/pending").set("Authorization", connectorAuth);
    expect(pending2.body.commands.length).toBe(0);

    // Connector acks DONE
    const ack = await request(app).post("/api/integrations/tally/commands/ack").set("Authorization", connectorAuth).send({
      commandId: push.body.id,
      status: "DONE",
    });
    expect(ack.status).toBe(200);
    expect(ack.body).toEqual({ id: push.body.id, status: "DONE" });
  });

  it("push rejects unknown connectors and bad commands", async () => {
    const res = await request(app)
      .post("/api/integrations/tally/commands")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ connectorId: "wz-connector-nope", command: "REQUEST_SYNC" });
    expect(res.status).toBe(404);

    const bad = await request(app)
      .post("/api/integrations/tally/commands")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ connectorId: "wz-connector-nope", command: "REBOOT_PC" });
    expect(bad.status).toBe(400);
  });
});
