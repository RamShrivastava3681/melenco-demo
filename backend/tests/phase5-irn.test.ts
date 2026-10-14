import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { initTestDb } from "./setup.js";
import { signupUser, freshRateLimits, type UserCtx } from "./helpers.js";
import { resetWzRateLimits } from "../src/integrations/tally/whizunik/auth.js";

let app: ReturnType<typeof createApp>;
let user: UserCtx;

const DEVICE_ID = "123e4567-e89b-12d3-a456-426614174005";

const SELLER_GSTIN = "27AAPCS1234F1Z5";
const BUYER_GSTIN = "29AADCB1234A1Z5";

const COMPLIANCE = {
  sellerGstin: SELLER_GSTIN,
  buyerGstin: BUYER_GSTIN,
  billingAddress: "101 MG Road, Bengaluru, Karnataka 560001",
  shippingAddress: "101 MG Road, Bengaluru, Karnataka 560001",
  placeOfSupply: "29-Karnataka",
  hsn: "8471",
};

beforeAll(async () => {
  await initTestDb();
  app = createApp();
  user = await signupUser(app, "phase5-irn@example.com");
});

beforeEach(() => {
  freshRateLimits();
  resetWzRateLimits();
});

async function pairConnector(companyName: string) {
  const pc = await request(app)
    .post("/api/integrations/tally/admin/pairing-codes")
    .set("Authorization", `Bearer ${user.token}`)
    .send({ tenantName: "Phase5 Tenant", companyName });
  expect(pc.status).toBe(201);
  const connect = await request(app).post("/api/integrations/tally/connect").send({
    pairingCode: pc.body.pairingCode,
    deviceId: `${DEVICE_ID}-${companyName.replace(/\s/g, "")}-${Date.now()}`,
    deviceName: "DESKTOP-PHASE5",
    appVersion: "1.0.0",
    protocolVersion: "1.0",
    company: { name: companyName, tallyGuid: `phase5-guid-${companyName}-${Date.now()}` },
  });
  expect(connect.status).toBe(200);
  return {
    connectorId: connect.body.connectorId as string,
    companyId: connect.body.companyMapping.whizunikCompanyId as string,
    accessToken: connect.body.accessToken as string,
  };
}

/** Create a Phase 4 line-detail invoice, push it, and ack it DONE (posted to Tally). */
async function postedInvoice(
  invoiceNumber: string,
  companyName: string,
  customerName: string,
  tallyVoucherNumber = invoiceNumber,
  tallyReference?: string
) {
  const { connectorId, companyId, accessToken } = await pairConnector(companyName);
  const cust = await request(app)
    .post("/api/customers")
    .set("Authorization", `Bearer ${user.token}`)
    .send({ name: customerName });
  expect(cust.status).toBe(201);

  const inv = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${user.token}`)
    .send({
      invoices: [
        {
          customer_id: cust.body.customer.id,
          invoice_number: invoiceNumber,
          issue_date: "2026-10-13",
          due_date: "2026-11-13",
          amount: 11800,
          quantity: 10,
          unit: "Nos",
          unit_price: 1000,
          gst_rate: 18,
          sku_code: "Phase5 Widget",
          grand_total: 11800,
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

  const ack = await request(app)
    .post("/api/integrations/tally/commands/ack")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({
      commandId: push.body.id,
      status: "DONE",
      result: {
        outcome: "synced",
        created: 1,
        duplicates: 0,
        failed: 0,
        companyName,
        connectorId,
        vouchers: [
          {
            invoiceId,
            invoiceNumber,
            tallyVoucherNumber,
            tallyReference: tallyReference ?? invoiceNumber,
            resultStatus: "created",
            completedAt: new Date().toISOString(),
          },
        ],
      },
    });
  expect(ack.status).toBe(200);
  return { invoiceId, connectorId, companyId };
}

describe("Phase 5: IRN generation through Tally (mock IRP)", () => {
  it("successful test: verified voucher → SUCCESS → IRN_GENERATED with linked refs", async () => {
    const { invoiceId } = await postedInvoice("INV-TEST-002", "Phase5 Co", "Phase5 Customer", "27", "INV-TEST-002");

    const res = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, compliance: COMPLIANCE });
    expect(res.status).toBe(201);
    expect(res.body.irn).toBe("TEST-IRN-001");
    expect(res.body.acknowledgementNumber).toBe("TEST-ACK-001");
    expect(res.body.irnStatus).toBe("IRN_GENERATED");
    expect(res.body.whizunikInvoiceNumber).toBe("INV-TEST-002");
    expect(res.body.tallyVoucherNumber).toBe("27");
    expect(res.body.tallyReference).toBe("INV-TEST-002");
    expect(res.body.duplicate).toBe(false);
    expect(res.body.testMode).toBe(true);
    expect(res.body.signedQrCode).toBe("TEST-QR-DATA");

    // Tally + WhizUnik references linked and visible.
    const status = await request(app)
      .get(`/api/integrations/tally/irn/status/${invoiceId}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(status.status).toBe(200);
    expect(status.body.whizunikInvoiceNumber).toBe("INV-TEST-002");
    expect(status.body.tallyVoucherNumber).toBe("27");
    expect(status.body.tallyReference).toBe("INV-TEST-002");
    expect(status.body.irn).toBe("TEST-IRN-001");
    expect(status.body.irnStatus).toBe("IRN_GENERATED");
  });

  it("duplicate protection: second request returns the existing IRN", async () => {
    const { invoiceId } = await postedInvoice("INV-DUP-001", "Phase5 Dup Co", "Phase5 Dup Customer");
    const first = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, compliance: COMPLIANCE });
    expect(first.status).toBe(201);
    const firstRequestId = first.body.irnRequestId as string;

    const second = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, compliance: COMPLIANCE });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.irn).toBe("TEST-IRN-001");
    expect(second.body.irnRequestId).toBe(firstRequestId);

    // Retry is also blocked once generated.
    const retry = await request(app)
      .post("/api/integrations/tally/irn/retry")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId });
    expect(retry.status).toBe(400);
  });

  it("preflight: exact missing field reported, then completed details succeed", async () => {
    const { invoiceId } = await postedInvoice("INV-PRE-001", "Phase5 Pre Co", "Phase5 Pre Customer");

    // No compliance details at all → first missing field is Seller GSTIN.
    const missing = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId });
    expect(missing.status).toBe(422);
    expect(missing.body.missingField).toBe("Seller GSTIN");
    expect(String(missing.body.error)).toContain("IRN cannot be requested.");

    // Invoice is NOT marked generated after the failed request.
    const st = await request(app)
      .get(`/api/integrations/tally/irn/status/${invoiceId}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(st.body.irn).toBeNull();
    expect(st.body.irnStatus).not.toBe("IRN_GENERATED");

    // Complete the details and retry → success.
    const done = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, compliance: COMPLIANCE });
    expect(done.status).toBe(201);
    expect(done.body.irnStatus).toBe("IRN_GENERATED");
  });

  it("rejection blocks progression; retry then succeeds", async () => {
    const { invoiceId } = await postedInvoice("INV-REJ-001", "Phase5 Rej Co", "Phase5 Rej Customer");

    const rejected = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, compliance: COMPLIANCE, mockMode: "REJECTED" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.irnStatus).toBe("IRN_FAILED");
    expect(rejected.body.errorCode).toBe("INVALID_GSTIN");
    expect(rejected.body.irn).toBeNull();

    const retry = await request(app)
      .post("/api/integrations/tally/irn/retry")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, mockMode: "SUCCESS" });
    expect(retry.status).toBe(200);
    expect(retry.body.irnStatus).toBe("IRN_GENERATED");
    expect(retry.body.irn).toBe("TEST-IRN-001");
  });

  it("retryable IRP outage stays retryable and never generates", async () => {
    const { invoiceId } = await postedInvoice("INV-RTRY-001", "Phase5 Rtry Co", "Phase5 Rtry Customer");

    const down = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, compliance: COMPLIANCE, mockMode: "RETRYABLE_ERROR" });
    expect(down.status).toBe(200);
    expect(down.body.irnStatus).toBe("IRN_RETRYABLE");
    expect(down.body.errorCode).toBe("IRP_UNAVAILABLE");
    expect(down.body.irn).toBeNull();

    // Retry while still down stays retryable…
    const again = await request(app)
      .post("/api/integrations/tally/irn/retry")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, mockMode: "RETRYABLE_ERROR" });
    expect(again.body.irnStatus).toBe("IRN_RETRYABLE");

    // …and succeeds once the IRP recovers.
    const recovered = await request(app)
      .post("/api/integrations/tally/irn/retry")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, mockMode: "SUCCESS" });
    expect(recovered.body.irnStatus).toBe("IRN_GENERATED");
  });

  it("tax mismatch and bad totals fail preflight with the exact field", async () => {
    const { invoiceId } = await postedInvoice("INV-TAX-001", "Phase5 Tax Co", "Phase5 Tax Customer");

    const mismatch = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, compliance: { ...COMPLIANCE, cgst: 100, sgst: 100, igst: 0 } });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.missingField).toBe("Tax amounts");

    const badTotal = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, compliance: { ...COMPLIANCE, cgst: 900, sgst: 900, igst: 0, grandTotal: 99999 } });
    expect(badTotal.status).toBe(422);
    expect(badTotal.body.missingField).toBe("Grand total");
  });

  it("unposted invoices cannot request an IRN", async () => {
    const cust = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ name: "Phase5 Open Customer" });
    const inv = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${user.token}`)
      .send({
        invoices: [
          {
            customer_id: cust.body.customer.id,
            invoice_number: "INV-OPEN-001",
            issue_date: "2026-10-13",
            due_date: "2026-11-13",
            amount: 11800,
          },
        ],
      });
    const res = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: inv.body.imported[0].id, compliance: COMPLIANCE });
    expect(res.status).toBe(422);
    expect(res.body.missingField).toBe("Tally voucher");
  });

  it("audit history records the full IRN trail with required references", async () => {
    const { invoiceId } = await postedInvoice("INV-AUD-001", "Phase5 Aud Co", "Phase5 Aud Customer");
    await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, compliance: COMPLIANCE });

    const res = await request(app)
      .get(`/api/integrations/tally/irn/audit?invoiceId=${invoiceId}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    const events = (res.body.events as Array<{ event: string; detail: Record<string, unknown> }>);
    const names = events.map((e) => e.event);
    for (const want of [
      "IRN_PREFLIGHT_STARTED",
      "IRN_PREFLIGHT_PASSED",
      "IRN_REQUEST_CREATED",
      "IRN_SUBMITTED",
      "IRN_RESPONSE_RECEIVED",
      "IRN_GENERATED",
      "IRN_RESULT_STORED",
    ]) {
      expect(names).toContain(want);
    }
    for (const e of events) {
      expect(e.detail.whizunikInvoiceId).toBe(invoiceId);
      expect(e.detail.whizunikInvoiceNumber).toBe("INV-AUD-001");
      expect(e.detail).toHaveProperty("tallyVoucherNumber");
      expect(e.detail).toHaveProperty("tallyReference");
      expect(e.detail).toHaveProperty("irnStatus");
    }
  });

  it("seed creates one-click demo invoices that get an IRN immediately", async () => {
    const seed = await request(app)
      .post("/api/integrations/tally/irn/seed")
      .set("Authorization", `Bearer ${user.token}`)
      .send({});
    expect(seed.status).toBe(201);
    expect(seed.body.created).toBe(2);
    const firstId = (seed.body.invoices as Array<{ id: string }>)[0].id as string;

    // No compliance needed — the seed carries the snapshot.
    const res = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: firstId });
    expect(res.status).toBe(201);
    expect(res.body.irn).toBe("TEST-IRN-001");
    expect(res.body.irnStatus).toBe("IRN_GENERATED");

    // Reseeding never duplicates.
    const again = await request(app)
      .post("/api/integrations/tally/irn/seed")
      .set("Authorization", `Bearer ${user.token}`)
      .send({});
    expect(again.body.created).toBe(0);
    expect(again.body.skipped).toBe(2);
  });
});
