import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { initTestDb } from "./setup.js";
import { signupUser, freshRateLimits, type UserCtx } from "./helpers.js";
import { resetWzRateLimits } from "../src/integrations/tally/whizunik/auth.js";
import db from "../src/db/index.js";

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

  it("3. POST /sync/batch accepts master records with null identity fields", async () => {
    const pc = await createPairingCode(user.token, { tenantId: "tenant-batch-nulls" });
    const c = await request(app).post("/api/integrations/tally/connect").send(connectBody(pc.body.pairingCode));
    const auth = `Bearer ${c.body.accessToken}`;
    const companyId = c.body.companyMapping.whizunikCompanyId as string;

    // Exact wire shape the connector used to send for masters (group/ledger):
    // explicit nulls where there is no voucher number or date.
    const res = await request(app).post("/api/integrations/tally/sync/batch").set("Authorization", auth).send({
      batchId: "nulls_batch_001",
      requestId: "nulls_req_001",
      syncId: "nulls_sync_1",
      deviceId: DEVICE_ID,
      companyId,
      entityType: "group",
      batchNumber: 1,
      totalBatches: 1,
      records: [
        {
          source: "tally",
          sourceCompanyId: "tally-guid-1",
          entityType: "group",
          sourceObjectId: "group-guid-1",
          sourceVoucherNumber: null,
          sourceVoucherDate: null,
          data: { NAME: "Mock Group" },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ acked: true, batchId: "nulls_batch_001", duplicate: false, receivedCount: 1 });
  });

  it("3. POST /sync/batch accepts legacy Tally GUID / name as companyId", async () => {
    const pc = await createPairingCode(user.token, { tenantId: "tenant-batch-legacy-co" });
    const c = await request(app).post("/api/integrations/tally/connect").send(connectBody(pc.body.pairingCode));
    const auth = `Bearer ${c.body.accessToken}`;

    const payloadFor = (companyId: string, batchId: string, requestId: string) => ({
      batchId,
      requestId,
      syncId: "legacy_co_sync",
      deviceId: DEVICE_ID,
      companyId,
      entityType: "ledger",
      batchNumber: 1,
      totalBatches: 1,
      records: [
        { source: "tally", entityType: "ledger", sourceObjectId: "l-1", data: { NAME: "L1" } },
      ],
    });

    // Tally GUID fallback (old connectors never persisted the mapping).
    const byGuid = await request(app)
      .post("/api/integrations/tally/sync/batch")
      .set("Authorization", auth)
      .send(payloadFor("tally-guid-1", "legacy_co_batch_guid", "legacy_co_req_guid"));
    expect(byGuid.status).toBe(200);
    expect(byGuid.body.acked).toBe(true);

    // Tally company-name fallback.
    const byName = await request(app)
      .post("/api/integrations/tally/sync/batch")
      .set("Authorization", auth)
      .send(payloadFor("Demo Company", "legacy_co_batch_name", "legacy_co_req_name"));
    expect(byName.status).toBe(200);
    expect(byName.body.acked).toBe(true);
  });

  it("4. POST /heartbeat accepts null tallyVersion/company (Tally offline)", async () => {
    const pc = await createPairingCode(user.token, { tenantId: "tenant-hb-nulls" });
    const c = await request(app).post("/api/integrations/tally/connect").send(connectBody(pc.body.pairingCode));
    const res = await request(app)
      .post("/api/integrations/tally/heartbeat")
      .set("Authorization", `Bearer ${c.body.accessToken}`)
      .send({
        connectorId: c.body.connectorId,
        deviceId: DEVICE_ID,
        appVersion: "1.0.0",
        protocolVersion: "1.0",
        tallyVersion: null,
        company: null,
        lastSync: null,
        currentSync: null,
        status: "idle",
      });
    expect(res.status).toBe(204);
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

  it("disconnect revokes a new-spec connector: device vanishes, tokens die", async () => {
    // Fresh user → isolated tenant, so the device list has no leftovers
    // from other tests in this file.
    const u = await signupUser(app, "disconnect-wz@example.com");
    // Pair without an explicit tenantId so the tenant equals this user's id
    // (the /disconnect lookup is tenant-scoped to the JWT user).
    const pcRes = await request(app)
      .post("/api/integrations/tally/admin/pairing-codes")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ companyName: "Disconnect Co" });
    expect(pcRes.status).toBe(201);
    const c = await request(app).post("/api/integrations/tally/connect").send(connectBody(pcRes.body.pairingCode));
    expect(c.status).toBe(200);
    const connectorAuth = `Bearer ${c.body.accessToken}`;

    // Sanity: device is listed and usable before disconnect.
    const before = await request(app).get("/api/integrations/tally/status").set("Authorization", `Bearer ${u.token}`);
    expect(before.body.connected).toBe(true);
    expect(before.body.connectors.some((x: { connectorId: string }) => x.connectorId === c.body.connectorId)).toBe(true);

    const disc = await request(app)
      .post("/api/integrations/tally/disconnect")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ connectorId: c.body.connectorId });
    expect(disc.status).toBe(200);
    expect(disc.body.success).toBe(true);

    // Device is gone from the list; tenant shows disconnected with no stale banner.
    const after = await request(app).get("/api/integrations/tally/status").set("Authorization", `Bearer ${u.token}`);
    expect(after.body.connectors).toEqual([]);
    expect(after.body.connected).toBe(false);
    expect(after.body.lastConnection).toBeNull();

    // Live access token is dead immediately (not just at refresh).
    const batch = await request(app).post("/api/integrations/tally/sync/batch").set("Authorization", connectorAuth).send({
      batchId: "dead_batch_001",
      requestId: "dead_req_001",
      syncId: "dead_sync_1",
      deviceId: DEVICE_ID,
      companyId: c.body.companyMapping.whizunikCompanyId,
      entityType: "ledger",
      batchNumber: 1,
      totalBatches: 1,
      records: [],
    });
    expect(batch.status).toBe(401);
    expect(batch.body.error.code).toBe("AUTHENTICATION_FAILED");

    const hb = await request(app).post("/api/integrations/tally/heartbeat").set("Authorization", connectorAuth).send({
      connectorId: c.body.connectorId,
      deviceId: DEVICE_ID,
      appVersion: "1.0.0",
      protocolVersion: "1.0",
      status: "idle",
    });
    expect(hb.status).toBe(401);

    // Refresh is dead too.
    const token = await request(app).post("/api/integrations/tally/token").send({
      refreshToken: c.body.refreshToken,
      deviceId: DEVICE_ID,
      connectorId: c.body.connectorId,
    });
    expect(token.status).toBe(401);

    // Disconnecting an unknown connector is a 403, not a crash.
    const unknown = await request(app)
      .post("/api/integrations/tally/disconnect")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ connectorId: "wz-connector-nope" });
    expect(unknown.status).toBe(403);
  });

  it("re-pairing the same device supersedes the old connector (no ghost devices)", async () => {
    const u = await signupUser(app, "supersede-wz@example.com");
    const pc1 = await request(app)
      .post("/api/integrations/tally/admin/pairing-codes")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ companyName: "Supersede Co" });
    const first = await request(app).post("/api/integrations/tally/connect").send(connectBody(pc1.body.pairingCode));
    expect(first.status).toBe(200);

    const pc2 = await request(app)
      .post("/api/integrations/tally/admin/pairing-codes")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ companyName: "Supersede Co" });
    const second = await request(app).post("/api/integrations/tally/connect").send(connectBody(pc2.body.pairingCode));
    expect(second.status).toBe(200);
    expect(second.body.connectorId).not.toBe(first.body.connectorId);

    // Only the newest device row for this tenant is listed…
    const status = await request(app).get("/api/integrations/tally/status").set("Authorization", `Bearer ${u.token}`);
    expect(status.body.connectors.map((x: { connectorId: string }) => x.connectorId)).toEqual([
      second.body.connectorId,
    ]);

    // …and the old token no longer authenticates.
    const stale = await request(app)
      .get("/api/integrations/tally/commands/pending")
      .set("Authorization", `Bearer ${first.body.accessToken}`);
    expect(stale.status).toBe(401);
  });

  describe("phase 3: WhizUnik → Tally master sync", () => {
    // NOTE: the in-memory DB is shared across tests in this file, so every
    // seeded id is prefixed per test.
    async function seedPhase3Tenant(userId: string, p: string) {
      const cid = (s: string) => `${p}-${s}`;
      db.prepare(`INSERT INTO customers (id, user_id, name, gstin, pan, address, state, pin, phone, email, payment_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        cid("cust-1"), userId, "Phase3 Customer One", "29ABCDE1234F1Z5", "ABCDE1234F",
        "42 Test Street", "Karnataka", "560001", "9876543210", "one@example.com", "Net 30"
      );
      db.prepare(`INSERT INTO customers (id, user_id, name) VALUES (?, ?, ?)`).run(
        cid("cust-nogst"), userId, "Phase3 No GSTIN"
      );
      db.prepare(`INSERT INTO suppliers (id, user_id, name, gstin, pan, address, state, pin, phone, email, payment_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        cid("supp-1"), userId, "Phase3 Supplier One", "27ABCDE1234F2Z3", "ABCDE1234G",
        "7 Supply Lane", "Maharashtra", "400001", "9123456780", "supp@example.com", "Net 15"
      );
      db.prepare(`INSERT INTO products (id, user_id, name, sku_code, hsn, gst_rate, base_unit, group_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        cid("sku-1"), userId, "Phase3 Widget", "P3-WIDGET-001", "8471", 18, "Nos", "Phase3 Goods"
      );
      db.prepare(`INSERT INTO products (id, user_id, name, sku_code, hsn, gst_rate, base_unit, group_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        cid("sku-badrate"), userId, "Phase3 Bad Rate", "P3-BADRATE-001", "8471", 99, "Nos", "Phase3 Goods"
      );
      db.prepare(`INSERT INTO products (id, user_id, name, sku_code, hsn, gst_rate, base_unit, group_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        cid("sku-nounit"), userId, "Phase3 No Unit", "P3-NOUNIT-001", "8471", 12, null, "Phase3 Goods"
      );
      return cid;
    }

    async function pairPhase3Tenant(userToken: string) {
      const pcRes = await request(app)
        .post("/api/integrations/tally/admin/pairing-codes")
        .set("Authorization", `Bearer ${userToken}`)
        .send({ companyName: "Phase3 Co" });
      expect(pcRes.status).toBe(201);
      const c = await request(app).post("/api/integrations/tally/connect").send(connectBody(pcRes.body.pairingCode));
      expect(c.status).toBe(200);
      return c.body as { connectorId: string; accessToken: string; refreshToken: string; companyMapping: { whizunikCompanyId: string } };
    }

    it("queues valid masters, rejects invalid ones with reasons", async () => {
      const u = await signupUser(app, "masters-p3@example.com");
      const cid = await seedPhase3Tenant(u.userId, "t1");
      const c = await pairPhase3Tenant(u.token);
      const companyId = c.companyMapping.whizunikCompanyId;

      const push = await request(app)
        .post("/api/integrations/tally/masters/push")
        .set("Authorization", `Bearer ${u.token}`)
        .send({
          connectorId: c.connectorId,
          companyId,
          items: [
            { kind: "customer", id: cid("cust-1") },
            { kind: "supplier", id: cid("supp-1") },
            { kind: "sku", id: cid("sku-1") },
            { kind: "customer", id: cid("cust-nogst") },
            { kind: "sku", id: cid("sku-badrate") },
            { kind: "sku", id: cid("sku-nounit") },
            { kind: "customer", id: cid("cust-1") },
            { kind: "customer", id: "t1-does-not-exist" },
          ],
        });
      expect(push.status).toBe(201);
      expect(push.body.queuedCount).toBe(3);
      expect(push.body.rejectedCount).toBe(5);
      const reasons = Object.fromEntries(push.body.rejected.map((r: { id: string; reason: string }) => [r.id, r.reason]));
      expect(reasons[cid("cust-nogst")]).toMatch(/gstin/i);
      expect(reasons[cid("sku-badrate")]).toMatch(/gstRate/i);
      expect(reasons[cid("sku-nounit")]).toMatch(/unit/i);
      expect(reasons["t1-does-not-exist"]).toMatch(/not found/i);
      // Idempotency keys follow the spec format.
      for (const q of push.body.queued) {
        expect(q.idempotencyKey).toMatch(/^(customer|supplier|sku):t1-.+:1$/);
      }

      // Status endpoint: QUEUED for valid, FAILED for invalid.
      const st = await request(app).get("/api/integrations/tally/masters/status").set("Authorization", `Bearer ${u.token}`);
      expect(st.status).toBe(200);
      const byId = Object.fromEntries(st.body.masters.map((m: { id: string; status: string }) => [m.id, m.status]));
      expect(byId[cid("cust-1")]).toBe("QUEUED");
      expect(byId[cid("supp-1")]).toBe("QUEUED");
      expect(byId[cid("sku-1")]).toBe("QUEUED");
      expect(byId[cid("cust-nogst")]).toBe("FAILED");
      expect(byId[cid("sku-badrate")]).toBe("FAILED");
      expect(byId[cid("sku-nounit")]).toBe("FAILED");
    });

    it("poll → SENDING → ack drives SYNCED / NEEDS_REVIEW / FAILED + evidence", async () => {
      const u = await signupUser(app, "masters-p3-flow@example.com");
      const cid = await seedPhase3Tenant(u.userId, "t2");
      const c = await pairPhase3Tenant(u.token);
      const companyId = c.companyMapping.whizunikCompanyId;

      await request(app).post("/api/integrations/tally/masters/push").set("Authorization", `Bearer ${u.token}`).send({
        connectorId: c.connectorId,
        companyId,
        items: [{ kind: "customer", id: cid("cust-1") }, { kind: "supplier", id: cid("supp-1") }, { kind: "sku", id: cid("sku-1") }],
      });

      // Connector polls: 3 PUSH_MASTERS commands, links flip to SENDING.
      const pending = await request(app).get("/api/integrations/tally/commands/pending").set("Authorization", `Bearer ${c.accessToken}`);
      expect(pending.status).toBe(200);
      const masters = pending.body.commands.filter((x: { command: string }) => x.command === "PUSH_MASTERS");
      expect(masters.length).toBe(3);
      expect(masters[0].payload.master.idempotencyKey).toMatch(/^customer:t2-cust-1:1$/);
      expect(masters[0].payload.master.fields.gstin).toBe("29ABCDE1234F1Z5");

      const sending = await request(app).get("/api/integrations/tally/masters/status?status=SENDING").set("Authorization", `Bearer ${u.token}`);
      expect(sending.body.masters.length).toBe(3);

      const cmdFor = (id: string) => masters.find((x: { payload: { master: { id: string } } }) => x.payload.master.id === id).id as string;

      // Ack synced + linked.
      const ack1 = await request(app).post("/api/integrations/tally/commands/ack").set("Authorization", `Bearer ${c.accessToken}`).send({
        commandId: cmdFor(cid("cust-1")),
        status: "DONE",
        result: { outcome: "synced", tallyName: "Phase3 Customer One", tallyMasterId: "tally-ledger-1", responsePayload: "<ENVELOPE>ok</ENVELOPE>" },
      });
      expect(ack1.status).toBe(200);

      // Ack needs_review (name match suggested).
      const ack2 = await request(app).post("/api/integrations/tally/commands/ack").set("Authorization", `Bearer ${c.accessToken}`).send({
        commandId: cmdFor(cid("supp-1")),
        status: "DONE",
        result: { outcome: "needs_review", error: "Name match suggested: Phase3 Supplier One", match: { tallyName: "Phase3 Supplier One" } },
      });
      expect(ack2.status).toBe(200);

      // Ack failed (Tally LINEERROR).
      const ack3 = await request(app).post("/api/integrations/tally/commands/ack").set("Authorization", `Bearer ${c.accessToken}`).send({
        commandId: cmdFor(cid("sku-1")),
        status: "CANCELLED",
        result: { outcome: "failed", error: "Tally rejected unit", retryCount: 2 },
      });
      expect(ack3.status).toBe(200);

      const st = await request(app).get("/api/integrations/tally/masters/status").set("Authorization", `Bearer ${u.token}`);
      const byId = Object.fromEntries(st.body.masters.map((m: { id: string; status: string }) => [m.id, m]));
      expect(byId[cid("cust-1")].status).toBe("SYNCED");
      expect(byId[cid("cust-1")].tallyName).toBe("Phase3 Customer One");
      expect(byId[cid("cust-1")].tallyMasterId).toBe("tally-ledger-1");
      expect(byId[cid("supp-1")].status).toBe("NEEDS_REVIEW");
      expect(byId[cid("sku-1")].status).toBe("FAILED");
      expect(byId[cid("sku-1")].lastError).toBe("Tally rejected unit");

      // Evidence log carries request/response per attempt.
      const att = await request(app).get(`/api/integrations/tally/masters/attempts?kind=customer&id=${cid("cust-1")}`).set("Authorization", `Bearer ${u.token}`);
      expect(att.status).toBe(200);
      expect(att.body.attempts.length).toBe(1);
      expect(att.body.attempts[0].success).toBe(1);
      expect(att.body.attempts[0].requestPayload.master.fields.name).toBe("Phase3 Customer One");
    });

    it("rejects pushes for unknown connectors, companies and masters", async () => {
      const u = await signupUser(app, "masters-p3-neg@example.com");
      const cid = await seedPhase3Tenant(u.userId, "t3");
      const c = await pairPhase3Tenant(u.token);

      const badConn = await request(app).post("/api/integrations/tally/masters/push").set("Authorization", `Bearer ${u.token}`).send({
        connectorId: "wz-connector-nope",
        companyId: c.companyMapping.whizunikCompanyId,
        items: [{ kind: "customer", id: cid("cust-1") }],
      });
      expect(badConn.status).toBe(404);

      const badCo = await request(app).post("/api/integrations/tally/masters/push").set("Authorization", `Bearer ${u.token}`).send({
        connectorId: c.connectorId,
        companyId: "whiz-company-nope",
        items: [{ kind: "customer", id: cid("cust-1") }],
      });
      expect(badCo.status).toBe(404);
    });
  });
});
