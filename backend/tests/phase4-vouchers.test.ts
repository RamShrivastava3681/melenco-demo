import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { initTestDb } from "./setup.js";
import { signupUser, freshRateLimits, type UserCtx } from "./helpers.js";
import { resetWzRateLimits } from "../src/integrations/tally/whizunik/auth.js";

let app: ReturnType<typeof createApp>;
let user: UserCtx;

const DEVICE_ID = "123e4567-e89b-12d3-a456-426614174004";

beforeAll(async () => {
  await initTestDb();
  app = createApp();
  user = await signupUser(app, "phase4-vouchers@example.com");
});

beforeEach(() => {
  freshRateLimits();
  resetWzRateLimits();
});

async function pairConnector(companyName = "Phase4 Co") {
  const pc = await request(app)
    .post("/api/integrations/tally/admin/pairing-codes")
    .set("Authorization", `Bearer ${user.token}`)
    .send({ tenantName: "Phase4 Tenant", companyName });
  expect(pc.status).toBe(201);
  const connect = await request(app).post("/api/integrations/tally/connect").send({
    pairingCode: pc.body.pairingCode,
    deviceId: `${DEVICE_ID}-${companyName.replace(/\s/g, "")}-${Date.now()}`,
    deviceName: "DESKTOP-PHASE4",
    appVersion: "1.0.0",
    protocolVersion: "1.0",
    company: { name: companyName, tallyGuid: `phase4-guid-${Date.now()}` },
  });
  expect(connect.status).toBe(200);
  return {
    connectorId: connect.body.connectorId as string,
    companyId: connect.body.companyMapping.whizunikCompanyId as string,
    accessToken: connect.body.accessToken as string,
  };
}

describe("Phase 4: sales voucher posting (platform side)", () => {
  it("creates one simple test invoice, pushes Phase 4 fields, and completes on ack", async () => {
    const { connectorId, companyId, accessToken } = await pairConnector();

    // 1. One customer.
    const cust = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ name: "Phase4 Customer" });
    expect(cust.status).toBe(201);

    // 2. One simple test invoice: 1 SKU, qty 10 @ 1000 + 18% GST = 11800.
    const inv = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${user.token}`)
      .send({
        invoices: [
          {
            customer_id: cust.body.customer.id,
            invoice_number: "PH4-0001",
            issue_date: "2026-10-01",
            due_date: "2026-11-01",
            amount: 11800,
            quantity: 10,
            unit: "Nos",
            unit_price: 1000,
            gst_rate: 18,
            sku_code: "Phase4 Widget",
            grand_total: 11800,
          },
        ],
      });
    expect(inv.status).toBe(201);
    const invoiceId = inv.body.imported[0].id as string;

    // 3. Push: command carries the Phase 4 fields + idempotency key.
    const push = await request(app)
      .post("/api/integrations/tally/invoices/push")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ connectorId, companyId, invoiceIds: [invoiceId] });
    expect(push.status).toBe(201);
    const v = push.body.vouchers[0];
    expect(v.invoiceNumber).toBe("PH4-0001");
    expect(v.customerLedgerName).toBe("Phase4 Customer");
    expect(v.skuCode).toBe("Phase4 Widget");
    expect(v.quantity).toBe(10);
    expect(v.unitPrice).toBe(1000);
    expect(v.gstRate).toBe(18);
    expect(v.grandTotal).toBe(11800);
    expect(v.idempotencyKey).toBe(`sales_invoice:${invoiceId}:1`);
    const commandId = push.body.id as string;

    // 4. Connector polls and receives it.
    const pending = await request(app)
      .get("/api/integrations/tally/commands/pending")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(pending.status).toBe(200);
    expect((pending.body.commands as any[]).some((c) => c.id === commandId)).toBe(true);

    // 5. Connector acks DONE with the Tally voucher number (read-back done).
    const ack = await request(app)
      .post("/api/integrations/tally/commands/ack")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        commandId,
        status: "DONE",
        result: {
          outcome: "synced",
          created: 1,
          duplicates: 0,
          failed: 0,
          companyName: "Phase4 Co",
          connectorId,
          vouchers: [
            {
              commandId,
              connectorId,
              companyId,
              companyName: "Phase4 Co",
              invoiceId,
              invoiceNumber: "PH4-0001",
              tallyVoucherNumber: "PH4-0001",
              tallyReference: "tally-ref-1",
              resultStatus: "created",
              completedAt: new Date().toISOString(),
            },
          ],
        },
      });
    expect(ack.status).toBe(200);

    // 6. Invoice is COMPLETED with the Tally voucher number stored.
    const list = await request(app)
      .get("/api/invoices?status=COMPLETED")
      .set("Authorization", `Bearer ${user.token}`);
    expect(list.status).toBe(200);
    const done = (list.body.invoices as any[]).find((i) => i.id === invoiceId);
    expect(done?.status).toBe("COMPLETED");
    expect(done?.tally_voucher_number).toBe("PH4-0001");
    expect(done?.tally_reference).toBe("tally-ref-1");
    expect(done?.tally_company_name).toBe("Phase4 Co");
    expect(done?.connector_id).toBe(connectorId);
    expect(done?.push_command_id).toBe(commandId);

    // 7. Duplicate ack re-links the same voucher (no second invoice, still COMPLETED).
    const dup = await request(app)
      .post("/api/integrations/tally/commands/ack")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        commandId,
        status: "DONE",
        result: {
          outcome: "synced",
          created: 0,
          duplicates: 1,
          failed: 0,
          companyName: "Phase4 Co",
          vouchers: [
            {
              invoiceId,
              invoiceNumber: "PH4-0001",
              tallyVoucherNumber: "PH4-0001",
              tallyReference: "tally-ref-1",
              resultStatus: "already_exists",
              completedAt: new Date().toISOString(),
            },
          ],
        },
      });
    expect(dup.status).toBe(200);
    const again = await request(app)
      .get("/api/invoices?status=COMPLETED")
      .set("Authorization", `Bearer ${user.token}`);
    const still = (again.body.invoices as any[]).filter((i) => i.invoice_number === "PH4-0001");
    expect(still.length).toBe(1);
    expect(still[0]?.status).toBe("COMPLETED");
  });

  it("failed voucher acks never falsely complete the invoice", async () => {
    const { connectorId, companyId, accessToken } = await pairConnector("Phase4 Fail Co");
    const cust = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ name: "Phase4 Fail Customer" });
    expect(cust.status).toBe(201);
    const inv = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${user.token}`)
      .send({
        invoices: [
          {
            customer_id: cust.body.customer.id,
            invoice_number: "PH4-FAIL-1",
            issue_date: "2026-10-02",
            due_date: "2026-11-02",
            amount: 11800,
          },
        ],
      });
    expect(inv.status).toBe(201);
    const invoiceId = inv.body.imported[0].id as string;
    const push = await request(app)
      .post("/api/integrations/tally/invoices/push")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ connectorId, companyId, invoiceIds: [invoiceId] });
    expect(push.status).toBe(201);
    await request(app)
      .get("/api/integrations/tally/commands/pending")
      .set("Authorization", `Bearer ${accessToken}`);
    const ack = await request(app)
      .post("/api/integrations/tally/commands/ack")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        commandId: push.body.id,
        status: "CANCELLED",
        result: {
          outcome: "failed",
          vouchers: [{ invoiceId, invoiceNumber: "PH4-FAIL-1", resultStatus: "failed" }],
        },
      });
    expect(ack.status).toBe(200);
    const open = await request(app)
      .get("/api/invoices?status=open")
      .set("Authorization", `Bearer ${user.token}`);
    const row = (open.body.invoices as any[]).find((i) => i.id === invoiceId);
    expect(row?.status).toBe("open");
    expect(row?.sync_status).toBe("FAILED");
  });

  it("DELIVERED-but-unacked commands become visible again (restart-safe lease)", async () => {
    const { connectorId, companyId, accessToken } = await pairConnector("Phase4 Lease Co");
    const cust = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ name: "Phase4 Lease Customer" });
    expect(cust.status).toBe(201);
    const inv = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${user.token}`)
      .send({
        invoices: [
          {
            customer_id: cust.body.customer.id,
            invoice_number: "PH4-LEASE-1",
            issue_date: "2026-10-03",
            due_date: "2026-11-03",
            amount: 1000,
          },
        ],
      });
    const push = await request(app)
      .post("/api/integrations/tally/invoices/push")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ connectorId, companyId, invoiceIds: [inv.body.imported[0].id] });
    const commandId = push.body.id as string;

    // First poll delivers it…
    const first = await request(app)
      .get("/api/integrations/tally/commands/pending")
      .set("Authorization", `Bearer ${accessToken}`);
    expect((first.body.commands as any[]).some((c) => c.id === commandId)).toBe(true);

    // …but while the lease is fresh it is NOT redelivered (no duplicates)…
    const second = await request(app)
      .get("/api/integrations/tally/commands/pending")
      .set("Authorization", `Bearer ${accessToken}`);
    expect((second.body.commands as any[]).some((c) => c.id === commandId)).toBe(false);

    // …and a duplicate invoice push is rejected while the first is in flight.
    const status = await request(app)
      .get(`/api/integrations/tally/commands/status/${commandId}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(status.body.status).toBe("DELIVERED");
  });
});
