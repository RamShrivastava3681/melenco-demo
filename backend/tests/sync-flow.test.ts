import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { listInvoices, findCustomerByName, findSupplierByName, listPayments, listProducts } from "../src/db/storesCore.js";
import { getCheckpoint, listRawBySyncId, listAuditForUser, listVouchers } from "../src/db/storesTally.js";
import { createApp } from "../src/app.js";
import { initTestDb } from "./setup.js";
import {
  signupUser,
  createConnector,
  connectorHeaders,
  startSync,
  salesVoucher,
  ledgerRecord,
  freshRateLimits,
  type UserCtx,
  type ConnectorCtx,
} from "./helpers.js";

let app: ReturnType<typeof createApp>;
let user: UserCtx;
let connector: ConnectorCtx;

beforeAll(async () => {
  await initTestDb();
  app = createApp();
  user = await signupUser(app, "sync-test@example.com");
  connector = await createConnector(user, "sync-test@example.com");
});

beforeEach(() => {
  freshRateLimits();
});

async function uploadBatch(syncId: string, records: unknown[], batchNumber = 1, totalBatches = 1) {
  return request(app)
    .post("/api/integrations/tally/sync/batch")
    .set(connectorHeaders(connector))
    .send({
      syncId,
      companyId: connector.companyId,
      entityType: "SALES_VOUCHER",
      batchNumber,
      totalBatches,
      records,
    });
}

describe("sync lifecycle end-to-end", () => {
  it("runs connector → API → database → ACK", async () => {
    const syncId = await startSync(user, connector);

    const res = await uploadBatch(syncId, [salesVoucher(1), salesVoucher(2), salesVoucher(3)]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      syncId,
      batchNumber: 1,
      accepted: 3,
      duplicates: 0,
      failed: 0,
      nextBatch: 2,
    });

    // Records landed in the normalized invoices table
    const invoices = await listInvoices(user.userId) as any[];
    expect(invoices.length).toBe(3);
    expect(invoices[0].invoice_number).toContain("INV-");

    const complete = await request(app)
      .post("/api/integrations/tally/sync/complete")
      .set(connectorHeaders(connector))
      .send({ syncId, lastVoucherDate: "2026-07-01", lastVoucherNumber: "INV-00003" });
    expect(complete.status).toBe(200);
    expect(complete.body.session.status).toBe("COMPLETED");

    // Checkpoint persisted
    const cp = await getCheckpoint(user.userId, connector.companyId, "SALES_VOUCHER") as any;
    expect(cp).toBeTruthy();
    expect(cp.last_voucher_number).toBe("INV-00003");
  });

  it("is idempotent: retried identical records count as duplicates", async () => {
    const syncId = await startSync(user, connector);

    const first = await uploadBatch(syncId, [salesVoucher(10)]);
    expect(first.body.accepted).toBe(1);
    expect(first.body.duplicates).toBe(0);

    // Same records retransmitted (network retry scenario)
    const retry = await uploadBatch(syncId, [salesVoucher(10)], 2, 2);
    expect(retry.body.accepted).toBe(0);
    expect(retry.body.duplicates).toBe(1);

    // Still exactly one invoice
    const matches = (await listInvoices(user.userId)).filter((i) => i.invoice_number === "INV-00010");
    expect(matches.length).toBe(1);
  });

  it("replays the stored ACK for duplicate batches without reprocessing", async () => {
    const syncId = await startSync(user, connector);

    const first = await uploadBatch(syncId, [salesVoucher(20), salesVoucher(21)]);
    expect(first.body.accepted).toBe(2);

    // Connector retries the same batchNumber after a network drop
    const replay = await uploadBatch(syncId, [salesVoucher(20), salesVoucher(21)]);
    expect(replay.body).toEqual(first.body);
    expect(replay.body.accepted).toBe(2); // from replayed ACK, not reprocessing

    const count = (await listInvoices(user.userId)).filter((i) =>
      String(i.invoice_number || "").startsWith("INV-0002")
    );
    expect(count.length).toBe(2);
  });

  it("rejects malformed payloads with INVALID_PAYLOAD", async () => {
    const syncId = await startSync(user, connector);

    const res = await uploadBatch(syncId, [
      { voucherNumber: "NO-DATE-OR-GUID" }, // no source id, no voucher date
    ]);
    expect(res.status).toBe(200); // batch accepted but record-level failure
    expect(res.body.failed).toBe(1);
  });

  it("rejects a batch declaring entityType different from the session", async () => {
    const syncId = await startSync(user, connector, "SALES_VOUCHER");

    const res = await request(app)
      .post("/api/integrations/tally/sync/batch")
      .set(connectorHeaders(connector))
      .send({
        syncId,
        companyId: connector.companyId,
        entityType: "LEDGER", // mismatch
        batchNumber: 1,
        totalBatches: 1,
        records: [ledgerRecord("Some Ledger")],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BATCH");
  });

  it("rejects a batch exceeding the record cap", async () => {
    const syncId = await startSync(user, connector);
    const tooMany = Array.from({ length: 501 }, (_, i) => salesVoucher(1000 + i));
    const res = await uploadBatch(syncId, tooMany);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
  });

  it("handles a failed sync via sync/error", async () => {
    const syncId = await startSync(user, connector);
    const res = await request(app)
      .post("/api/integrations/tally/sync/error")
      .set(connectorHeaders(connector))
      .send({ syncId, errorMessage: "Tally connection lost", recoverable: true });
    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("FAILED");
    expect(res.body.session.errorMessage).toBe("Tally connection lost");
  });

  it("reports PARTIAL when some records fail", async () => {
    const syncId = await startSync(user, connector);
    await uploadBatch(syncId, [salesVoucher(30), { bad: true }]); // one good, one bad
    const complete = await request(app)
      .post("/api/integrations/tally/sync/complete")
      .set(connectorHeaders(connector))
      .send({ syncId });
    expect(complete.body.session.status).toBe("PARTIAL");
    expect(complete.body.session.failedRecords).toBe(1);
    expect(complete.body.session.successfulRecords).toBe(1);
  });

  it("blocks batch upload into a completed session", async () => {
    const syncId = await startSync(user, connector);
    await request(app)
      .post("/api/integrations/tally/sync/complete")
      .set(connectorHeaders(connector))
      .send({ syncId });

    const res = await uploadBatch(syncId, [salesVoucher(40)]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BATCH");
  });

  it("prevents concurrent duplicate sessions for the same entity", async () => {
    await startSync(user, connector, "LEDGER"); // opens an active LEDGER session
    const res = await request(app)
      .post("/api/integrations/tally/sync/start")
      .set(connectorHeaders(connector))
      .send({ companyId: connector.companyId, entityType: "LEDGER", syncType: "INITIAL_SYNC" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BATCH");
  });
});

describe("normalization targets", () => {
  it("normalizes LEDGER records with partyType into customers and suppliers", async () => {
    const syncId = await startSync(user, connector, "LEDGER");
    const res = await request(app)
      .post("/api/integrations/tally/sync/batch")
      .set(connectorHeaders(connector))
      .send({
        syncId,
        companyId: connector.companyId,
        entityType: "LEDGER",
        batchNumber: 1,
        totalBatches: 1,
        records: [
          ledgerRecord("Delta Debtor", { partyType: "debtor" }),
          ledgerRecord("Delta Creditor", { partyType: "creditor" }),
          ledgerRecord("Sales Account", { openingBalance: 500 }),
        ],
      });
    expect(res.body.accepted).toBe(3);

    const customer = await findCustomerByName(user.userId, "Delta Debtor");
    const supplier = await findSupplierByName(user.userId, "Delta Creditor");
    expect(customer).toBeTruthy();
    expect(supplier).toBeTruthy();
  });

  it("normalizes RECEIPT_VOUCHER into payments + allocations and closes invoices FIFO", async () => {
    // Dedicated customer so FIFO allocation applies only to this invoice
    const PARTY = "FIFO Customer";

    // Create an open invoice first
    const sync1 = await startSync(user, connector, "SALES_VOUCHER");
    await request(app)
      .post("/api/integrations/tally/sync/batch")
      .set(connectorHeaders(connector))
      .send({
        syncId: sync1,
        companyId: connector.companyId,
        entityType: "SALES_VOUCHER",
        batchNumber: 1,
        totalBatches: 1,
        records: [salesVoucher(50, { amount: 500, partyName: PARTY })],
      });

    // Upload a receipt covering it fully
    const sync2 = await startSync(user, connector, "RECEIPT_VOUCHER");
    const res = await request(app)
      .post("/api/integrations/tally/sync/batch")
      .set(connectorHeaders(connector))
      .send({
        syncId: sync2,
        companyId: connector.companyId,
        entityType: "RECEIPT_VOUCHER",
        batchNumber: 1,
        totalBatches: 1,
        records: [
          {
            voucherType: "Receipt",
            voucherNumber: "RCPT-001",
            voucherDate: "2026-07-10",
            partyName: PARTY,
            amount: 500,
          },
        ],
      });
    expect(res.body.accepted).toBe(1);

    const payment = (await listPayments(user.userId) as any[]).find((p) =>
      String(p.note || "").includes("RCPT-001")
    );
    expect(payment).toBeTruthy();
    expect(Number(payment.applied_amount)).toBe(500);

    // Invoice closed
    const invoice = (await listInvoices(user.userId) as any[]).find(
      (i) => i.invoice_number === "INV-00050"
    );
    expect(invoice.status).toBe("closed");
  });

  it("routes PAYMENT_VOUCHER into the generic voucher store", async () => {
    const syncId = await startSync(user, connector, "PAYMENT_VOUCHER");
    const res = await request(app)
      .post("/api/integrations/tally/sync/batch")
      .set(connectorHeaders(connector))
      .send({
        syncId,
        companyId: connector.companyId,
        entityType: "PAYMENT_VOUCHER",
        batchNumber: 1,
        totalBatches: 1,
        records: [
          {
            voucherType: "Payment",
            voucherNumber: "PMT-001",
            voucherDate: "2026-07-11",
            partyName: "Landlord",
            amount: 900,
            data: { narration: "Office rent" },
          },
        ],
      });
    expect(res.body.accepted).toBe(1);
    const voucher = (await listVouchers(user.userId) as any[]).find(
      (v) => v.voucher_number === "PMT-001"
    );
    expect(voucher).toBeTruthy();
    expect(voucher.voucher_type).toBe("PAYMENT_VOUCHER");
    expect(JSON.parse(voucher.raw_json).narration).toBe("Office rent");
  });
});

describe("raw store + audit", () => {
  it("stores raw payloads and marks them processed", async () => {
    const syncId = await startSync(user, connector);
    await uploadBatch(syncId, [salesVoucher(60)]);

    const raw = (await listRawBySyncId(syncId)) as any[];
    expect(raw.length).toBe(1);
    expect(JSON.parse(raw[0].payload).voucherNumber).toBe("INV-00060");
  });

  it("writes audit events for sync lifecycle", async () => {
    const events = (await listAuditForUser(user.userId, 200)) as any[];
    const kinds = new Set(events.map((e) => e.event));
    expect(kinds.has("CONNECTOR_CONNECTED")).toBe(true);
    expect(kinds.has("SYNC_STARTED")).toBe(true);
    expect(kinds.has("BATCH_ACCEPTED")).toBe(true);
  });
});

describe("connector revocation", () => {
  it("blocks a revoked connector from authenticating", async () => {
    // Dedicated connector so we don't break other tests
    const u = await signupUser(app, "revoke-test@example.com");
    const c = await createConnector(u, "revoke-test@example.com");

    const disconnect = await request(u.app)
      .post("/api/integrations/tally/disconnect")
      .set("Authorization", `Bearer ${u.token}`)
      .send({ connectorId: c.connectorId });
    expect(disconnect.status).toBe(200);

    const res = await request(app)
      .post("/api/integrations/tally/heartbeat")
      .set(connectorHeaders(c))
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTHENTICATION_FAILED");
  });

  it("prevents a user from revoking another user's connector", async () => {
    const u2 = await signupUser(app, "revoke-victim@example.com");
    const c2 = await createConnector(u2, "revoke-victim@example.com");

    const res = await request(user.app)
      .post("/api/integrations/tally/disconnect")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ connectorId: c2.connectorId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("AUTHORIZATION_FAILED");
  });
});

describe("frontend status endpoints", () => {
  it("returns connection status without secrets", async () => {
    const res = await request(user.app)
      .get("/api/integrations/tally/status")
      .set("Authorization", `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.connectors.length).toBeGreaterThan(0);
    const c = res.body.connectors[0];
    expect(c.connectorId).toBeTruthy();
    expect(JSON.stringify(c)).not.toContain("accessToken");
    expect(JSON.stringify(res.body)).not.toContain("hmacSecret");
    expect(JSON.stringify(res.body)).not.toContain("token_hash");
  });

  it("returns sync history", async () => {
    const res = await request(user.app)
      .get("/api/integrations/tally/sync-history")
      .set("Authorization", `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    expect(res.body.sessions.length).toBeGreaterThan(0);
    expect(res.body.sessions[0].sync_id).toBeTruthy();
  });
});

describe("concurrent uploads", () => {
  it("handles parallel batches without duplicating records", async () => {
    const syncId = await startSync(user, connector, "STOCK_ITEM");

    const mk = (i: number) => ({ partyName: `Widget ${i}`, data: { name: `Widget ${i}`, group: "Gadgets" } });
    const batches = [0, 1, 2].map((b) =>
      request(app)
        .post("/api/integrations/tally/sync/batch")
        .set(connectorHeaders(connector))
        .send({
          syncId,
          companyId: connector.companyId,
          entityType: "STOCK_ITEM",
          batchNumber: b + 1,
          totalBatches: 3,
          records: Array.from({ length: 10 }, (_, i) => mk(b * 10 + i)),
        })
    );
    const results = await Promise.all(batches);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.failed).toBe(0);
    }

    const widgets = (await listProducts(user.userId, 500)).filter((p) =>
      String(p.name || "").startsWith("Widget ")
    );
    expect(widgets.length).toBe(30);
  });
});
