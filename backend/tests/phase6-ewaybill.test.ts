import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { initTestDb } from "./setup.js";
import { signupUser, freshRateLimits, type UserCtx } from "./helpers.js";
import { resetWzRateLimits } from "../src/integrations/tally/whizunik/auth.js";

let app: ReturnType<typeof createApp>;
let user: UserCtx;

const DEVICE_ID = "123e4567-e89b-12d3-a456-426614174006";

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

const DISPATCH = {
  dispatchWarehouse: "Main Warehouse",
  originAddress: "101 MG Road, Bengaluru, Karnataka 560001",
  originPin: "560001",
  destinationAddress: "201 Andheri West, Mumbai, Maharashtra 400072",
  destinationPin: "400072",
  placeOfSupply: "27-Maharashtra",
  transporterName: "Delhivery",
  transporterId: "214243",
  transportMode: "Road",
  vehicleNumber: "KA01AB1234",
  transportDocNumber: "LR-1001",
  transportDocDate: "2026-10-13",
  distanceKm: 23,
  packageCount: 10,
  packageType: "Boxes",
  expectedDispatchDate: "2026-10-14",
};

beforeAll(async () => {
  await initTestDb();
  app = createApp();
  user = await signupUser(app, "phase6-ewb@example.com");
});

beforeEach(() => {
  freshRateLimits();
  resetWzRateLimits();
});

async function pairConnector(companyName: string) {
  const pc = await request(app)
    .post("/api/integrations/tally/admin/pairing-codes")
    .set("Authorization", `Bearer ${user.token}`)
    .send({ tenantName: "Phase6 Tenant", companyName });
  expect(pc.status).toBe(201);
  const connect = await request(app).post("/api/integrations/tally/connect").send({
    pairingCode: pc.body.pairingCode,
    deviceId: `${DEVICE_ID}-${companyName.replace(/\s/g, "")}-${Date.now()}`,
    deviceName: "DESKTOP-PHASE6",
    appVersion: "1.0.0",
    protocolVersion: "1.0",
    company: { name: companyName, tallyGuid: `phase6-guid-${companyName}-${Date.now()}` },
  });
  expect(connect.status).toBe(200);
  return {
    connectorId: connect.body.connectorId as string,
    companyId: connect.body.companyMapping.whizunikCompanyId as string,
    accessToken: connect.body.accessToken as string,
  };
}

/** Phase 4-posted + Phase 5 IRN-verified invoice, ready for dispatch capture. */
async function irnVerifiedInvoice(
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
          sku_code: "Phase6 Widget",
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

  const irn = await request(app)
    .post("/api/integrations/tally/irn/request")
    .set("Authorization", `Bearer ${user.token}`)
    .send({ invoiceId, compliance: COMPLIANCE });
  expect(irn.status).toBe(201);
  expect(irn.body.irnStatus).toBe("IRN_GENERATED");

  return { invoiceId, connectorId, companyId, accessToken };
}

describe("Phase 6: E-way bill generation (mock adapter)", () => {
  const today = () => new Date().toISOString().slice(0, 10);

  it("successful test: seeded INV-DEMO-001 → IRN generated, then random 12-digit EWB, dispatch released", async () => {
    const seed = await request(app)
      .post("/api/integrations/tally/ewaybill/seed")
      .set("Authorization", `Bearer ${user.token}`)
      .send({});
    expect(seed.status).toBe(201);
    const first = (seed.body.invoices as Array<{ id: string; invoice_number: string }>).find(
      (i) => i.invoice_number === "INV-DEMO-001"
    )!;
    expect(first).toBeTruthy();

    // The seed presets NOTHING hardcoded: IRN is generated through the flow.
    const irnRes = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: first.id });
    expect(irnRes.status).toBe(201);
    expect(irnRes.body.irn).toMatch(/^[0-9A-F]{64}$/);
    const irn = irnRes.body.irn as string;

    const res = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: first.id });
    expect(res.status).toBe(201);
    // Fresh random 12-digit number like the real portal issues — never hardcoded.
    expect(res.body.ewayBillNumber).toMatch(/^\d{12}$/);
    expect(res.body.ewayBillStatus).toBe("EWB_GENERATED");
    expect(res.body.whizunikInvoiceNumber).toBe("INV-DEMO-001");
    expect(res.body.tallyVoucherNumber).toBe("27");
    expect(res.body.tallyReference).toBe("INV-DEMO-001");
    expect(res.body.irn).toBe(irn);
    expect(res.body.generatedDate).toBe(today());
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    expect(res.body.validUntil).toBe(tomorrow); // 23 km → 1 day validity
    expect(res.body.dispatchStatus).toBe("DISPATCH_RELEASED");
    expect(res.body.inventoryStatus).toBe("INVENTORY_DEDUCTED");
    expect(res.body.duplicate).toBe(false);
    expect(res.body.environment).toBe("MOCK");
    expect(res.body.legallyValid).toBe(false);
    expect(res.body.ewayBillRequestId).toMatch(/^ewb_/);

    // Linked status view carries Tally + IRN + EWB refs.
    const status = await request(app)
      .get(`/api/integrations/tally/ewaybill/status/${first.id}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(status.status).toBe(200);
    expect(status.body.whizunikInvoiceNumber).toBe("INV-DEMO-001");
    expect(status.body.tallyVoucherNumber).toBe("27");
    expect(status.body.irn).toBe(irn);
    expect(status.body.ewayBillNumber).toBe(res.body.ewayBillNumber);
    expect(status.body.ewayBillStatus).toBe("EWB_GENERATED");
    expect(status.body.dispatchStatus).toBe("DISPATCH_RELEASED");
  });

  it("invoice PDF: TAX INVOICE + e-Way Bill attached, MOCK-labelled", async () => {
    const seed = await request(app)
      .post("/api/integrations/tally/ewaybill/seed")
      .set("Authorization", `Bearer ${user.token}`)
      .send({});
    const first = (seed.body.invoices as Array<{ id: string; invoice_number: string }>).find(
      (i) => i.invoice_number === "INV-DEMO-001"
    )!;
    // Ensure IRN + EWB generated (idempotent — returns existing when done).
    await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: first.id });
    await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: first.id });

    const st = await request(app)
      .get(`/api/integrations/tally/ewaybill/status/${first.id}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(st.body.ewayBillStatus).toBe("EWB_GENERATED");

    const pdf = await request(app)
      .get(`/api/integrations/tally/ewaybill/invoice-pdf/${first.id}`)
      .set("Authorization", `Bearer ${user.token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    const raw = (pdf.body as Buffer).toString("utf8");
    expect(raw.slice(0, 8)).toBe("%PDF-1.4");
    expect(raw).toContain("TAX INVOICE");
    expect(raw).toContain("e-Way Bill");
    expect(raw).toContain(st.body.ewayBillNumber as string);
    expect(raw).toContain(st.body.irn as string);
    expect(raw).toContain("INV-DEMO-001");
    expect(raw).toContain("MOCK");
    expect(raw).toContain("Legally Valid: NO");
  });

  it("different invoices get different generated e-way bill numbers", async () => {
    const a = await irnVerifiedInvoice("INV-EWB-A", "Phase6 Gen Co A", "Phase6 Gen Customer A");
    const b = await irnVerifiedInvoice("INV-EWB-B", "Phase6 Gen Co B", "Phase6 Gen Customer B");
    const auth = { Authorization: `Bearer ${user.token}` };
    const ra = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set(auth)
      .send({ invoiceId: a.invoiceId, dispatch: DISPATCH });
    const rb = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set(auth)
      .send({ invoiceId: b.invoiceId, dispatch: DISPATCH });
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(ra.body.ewayBillNumber).toMatch(/^\d{12}$/);
    expect(rb.body.ewayBillNumber).toMatch(/^\d{12}$/);
    expect(ra.body.ewayBillNumber).not.toBe(rb.body.ewayBillNumber);
    expect(ra.body.dispatchStatus).toBe("DISPATCH_RELEASED");
    expect(ra.body.inventoryStatus).toBe("INVENTORY_DEDUCTED");
  });

  it("duplicate protection: second request returns the existing e-way bill", async () => {
    const { invoiceId } = await irnVerifiedInvoice("INV-EWB-DUP", "Phase6 Dup Co", "Phase6 Dup Customer");
    const first = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, dispatch: DISPATCH });
    expect(first.status).toBe(201);
    const firstRequestId = first.body.ewayBillRequestId as string;

    const second = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, dispatch: DISPATCH });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.ewayBillNumber).toBe(first.body.ewayBillNumber);
    expect(second.body.ewayBillRequestId).toBe(firstRequestId);

    // Retry is also blocked once generated.
    const retry = await request(app)
      .post("/api/integrations/tally/ewaybill/retry")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId });
    expect(retry.status).toBe(400);
  });

  it("preflight: exact missing field reported, then completed dispatch succeeds", async () => {
    const { invoiceId } = await irnVerifiedInvoice("INV-EWB-PRE", "Phase6 Pre Co", "Phase6 Pre Customer");

    // No dispatch details at all → first missing field is the warehouse.
    const missing = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId });
    expect(missing.status).toBe(422);
    expect(missing.body.missingField).toBe("Dispatch warehouse");
    expect(String(missing.body.error)).toContain("E-way bill cannot be requested.");

    // Partial dispatch (no vehicle) → exact vehicle field.
    const noVehicle = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, dispatch: { ...DISPATCH, vehicleNumber: undefined } });
    expect(noVehicle.status).toBe(422);
    expect(noVehicle.body.missingField).toBe("Vehicle number");

    // Nothing generated after failed requests; dispatch not released.
    const st = await request(app)
      .get(`/api/integrations/tally/ewaybill/status/${invoiceId}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(st.body.ewayBillNumber).toBeNull();
    expect(st.body.ewayBillStatus).not.toBe("EWB_GENERATED");
    expect(st.body.dispatchStatus).not.toBe("DISPATCH_RELEASED");
    expect(st.body.inventoryStatus).toBe("INVENTORY_NOT_DEDUCTED");

    // Complete the dispatch and retry → success.
    const done = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, dispatch: DISPATCH });
    expect(done.status).toBe(201);
    expect(done.body.ewayBillStatus).toBe("EWB_GENERATED");
  });

  it("rejection blocks dispatch; retry then succeeds", async () => {
    const { invoiceId } = await irnVerifiedInvoice("INV-EWB-REJ", "Phase6 Rej Co", "Phase6 Rej Customer");

    const rejected = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, dispatch: DISPATCH, mockMode: "INVALID_VEHICLE" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.ewayBillStatus).toBe("EWB_FAILED");
    expect(rejected.body.errorCode).toBe("INVALID_VEHICLE");
    expect(rejected.body.errorMessage).toBe("Vehicle number is invalid");
    expect(rejected.body.ewayBillNumber).toBeNull();
    expect(rejected.body.dispatchStatus).toBe("DISPATCH_BLOCKED");
    expect(rejected.body.inventoryStatus).toBe("INVENTORY_NOT_DEDUCTED");

    const retry = await request(app)
      .post("/api/integrations/tally/ewaybill/retry")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, mockMode: "SUCCESS" });
    expect(retry.status).toBe(200);
    expect(retry.body.ewayBillStatus).toBe("EWB_GENERATED");
    expect(retry.body.ewayBillNumber).toMatch(/^\d{12}$/);
    expect(retry.body.dispatchStatus).toBe("DISPATCH_RELEASED");
    expect(retry.body.inventoryStatus).toBe("INVENTORY_DEDUCTED");
  });

  it("retryable outage stays retryable and never generates or deducts", async () => {
    const { invoiceId } = await irnVerifiedInvoice("INV-EWB-RTRY", "Phase6 Rtry Co", "Phase6 Rtry Customer");

    const down = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, dispatch: DISPATCH, mockMode: "RETRYABLE_ERROR" });
    expect(down.status).toBe(200);
    expect(down.body.ewayBillStatus).toBe("EWB_RETRYABLE");
    expect(down.body.errorCode).toBe("EWB_SERVICE_UNAVAILABLE");
    expect(down.body.ewayBillNumber).toBeNull();
    expect(down.body.dispatchStatus).toBe("DISPATCH_BLOCKED");
    expect(down.body.inventoryStatus).toBe("INVENTORY_NOT_DEDUCTED");

    // Retry while still down stays retryable…
    const again = await request(app)
      .post("/api/integrations/tally/ewaybill/retry")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, mockMode: "RETRYABLE_ERROR" });
    expect(again.body.ewayBillStatus).toBe("EWB_RETRYABLE");
    expect(again.body.inventoryStatus).toBe("INVENTORY_NOT_DEDUCTED");

    // …and succeeds once the service recovers.
    const recovered = await request(app)
      .post("/api/integrations/tally/ewaybill/retry")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, mockMode: "SUCCESS" });
    expect(recovered.body.ewayBillStatus).toBe("EWB_GENERATED");
  });

  it("invalid PIN and bad totals fail preflight with the exact field", async () => {
    const { invoiceId } = await irnVerifiedInvoice("INV-EWB-PIN", "Phase6 Pin Co", "Phase6 Pin Customer");

    const badPin = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, dispatch: { ...DISPATCH, destinationPin: "000" } });
    expect(badPin.status).toBe(422);
    expect(badPin.body.missingField).toBe("Destination PIN");

    const badTotal = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, dispatch: { ...DISPATCH, invoiceTotal: 99999 } });
    expect(badTotal.status).toBe(422);
    expect(badTotal.body.missingField).toBe("Invoice total");
  });

  it("unposted invoices and IRN-less invoices cannot request an e-way bill", async () => {
    const cust = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ name: "Phase6 Open Customer" });
    const inv = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${user.token}`)
      .send({
        invoices: [
          {
            customer_id: cust.body.customer.id,
            invoice_number: "INV-EWB-OPEN",
            issue_date: "2026-10-13",
            due_date: "2026-11-13",
            amount: 11800,
          },
        ],
      });
    const res = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: inv.body.imported[0].id, dispatch: DISPATCH });
    expect(res.status).toBe(422);
    expect(res.body.missingField).toBe("Tally voucher");

    // Posted to Tally but no IRN → IRN gate.
    const { connectorId, companyId, accessToken } = await pairConnector("Phase6 NoIrn Co");
    const cust2 = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ name: "Phase6 NoIrn Customer" });
    const inv2 = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${user.token}`)
      .send({
        invoices: [
          {
            customer_id: cust2.body.customer.id,
            invoice_number: "INV-EWB-NOIRN",
            issue_date: "2026-10-13",
            due_date: "2026-11-13",
            amount: 11800,
            quantity: 10,
            unit: "Nos",
            unit_price: 1000,
            gst_rate: 18,
            grand_total: 11800,
          },
        ],
      });
    const invoiceId2 = inv2.body.imported[0].id as string;
    const push = await request(app)
      .post("/api/integrations/tally/invoices/push")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ connectorId, companyId, invoiceIds: [invoiceId2] });
    expect(push.status).toBe(201);
    await request(app)
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
          companyName: "Phase6 NoIrn Co",
          connectorId,
          vouchers: [
            {
              invoiceId: invoiceId2,
              invoiceNumber: "INV-EWB-NOIRN",
              tallyVoucherNumber: "INV-EWB-NOIRN",
              tallyReference: "INV-EWB-NOIRN",
              resultStatus: "created",
              completedAt: new Date().toISOString(),
            },
          ],
        },
      });
    const noIrn = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: invoiceId2, dispatch: DISPATCH });
    expect(noIrn.status).toBe(422);
    expect(noIrn.body.missingField).toBe("IRN");
  });

  it("audit history records the full EWB trail with required references", async () => {
    const { invoiceId } = await irnVerifiedInvoice("INV-EWB-AUD", "Phase6 Aud Co", "Phase6 Aud Customer");
    await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, dispatch: DISPATCH });

    const res = await request(app)
      .get(`/api/integrations/tally/ewaybill/audit?invoiceId=${invoiceId}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(res.status).toBe(200);
    const events = (res.body.events as Array<{ event: string; detail: Record<string, unknown> }>);
    const names = events.map((e) => e.event);
    for (const want of [
      "EWB_PREFLIGHT_STARTED",
      "EWB_PREFLIGHT_PASSED",
      "EWB_REQUEST_CREATED",
      "EWB_SUBMITTED",
      "EWB_RESPONSE_RECEIVED",
      "EWB_GENERATED",
      "EWB_RESULT_STORED",
      "DISPATCH_RELEASED",
      "INVENTORY_DEDUCTED",
    ]) {
      expect(names).toContain(want);
    }
    for (const e of events) {
      expect(e.detail.whizunikInvoiceId).toBe(invoiceId);
      expect(e.detail.whizunikInvoiceNumber).toBe("INV-EWB-AUD");
      expect(e.detail).toHaveProperty("tallyVoucherNumber");
      expect(e.detail).toHaveProperty("tallyReference");
      expect(e.detail).toHaveProperty("irn");
      expect(e.detail).toHaveProperty("ewayBillStatus");
    }
  });

  it("seed creates posted invoices with no hardcoded IRN/EWB; IRN then EWB generate through the flow", async () => {
    const seed = await request(app)
      .post("/api/integrations/tally/ewaybill/seed")
      .set("Authorization", `Bearer ${user.token}`)
      .send({});
    expect(seed.status).toBe(201);
    expect(seed.body.invoices).toHaveLength(2);
    // Nothing hardcoded: seeded rows carry no TEST-IRN-*/TEST-EWB-* values.
    // (INV-DEMO-001 may already hold a flow-generated IRN from the test above —
    // the reseed repair preserves it; INV-DEMO-002 is still untouched.)
    const byNumber = Object.fromEntries(
      (seed.body.invoices as Array<{ invoice_number: string; irn: string | null; irnStatus: string; ewayBillStatus: string }>).map(
        (i) => [i.invoice_number, i]
      )
    );
    for (const inv of Object.values(byNumber)) {
      expect(inv.irn == null || /^[0-9A-F]{64}$/.test(inv.irn)).toBe(true);
    }
    expect(byNumber["INV-DEMO-002"].irn).toBeNull();
    expect(byNumber["INV-DEMO-002"].irnStatus).toBe("IRN_PENDING");
    expect(byNumber["INV-DEMO-002"].ewayBillStatus).toBe("EWB_PENDING");
    expect(seed.body.nextSteps).toHaveLength(3);
    // Exercise the flow on INV-DEMO-002 (untouched by earlier tests).
    const firstId = (seed.body.invoices as Array<{ id: string; invoice_number: string }>).find(
      (i) => i.invoice_number === "INV-DEMO-002"
    )!.id;

    // IRN is generated (per-invoice hash), then the EWB mints a random number.
    const irnRes = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: firstId });
    expect(irnRes.status).toBe(201);
    expect(irnRes.body.irn).toMatch(/^[0-9A-F]{64}$/);

    // No dispatch needed — the seed carries the snapshot.
    const res = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: firstId });
    expect([200, 201]).toContain(res.status);
    expect(res.body.ewayBillStatus).toBe("EWB_GENERATED");
    expect(res.body.ewayBillNumber).toMatch(/^\d{12}$/);

    // Reseeding repairs gaps without duplicating invoice numbers or
    // clobbering generated IRN/EWB state.
    const again = await request(app)
      .post("/api/integrations/tally/ewaybill/seed")
      .set("Authorization", `Bearer ${user.token}`)
      .send({});
    expect(again.body.created).toBe(0);
    expect(again.body.skipped).toBe(2);
    const kept = (again.body.invoices as Array<{ invoice_number: string; irn: string | null }>).find(
      (i) => i.invoice_number === "INV-DEMO-002"
    )!;
    expect(kept.irn).toBe(irnRes.body.irn);
  });

  it("fresh flow: new customers + OPEN invoices → simulate-post → IRN → random EWB (single transaction)", async () => {
    const seed = await request(app)
      .post("/api/integrations/tally/ewaybill/seed-fresh")
      .set("Authorization", `Bearer ${user.token}`)
      .send({});
    expect(seed.status).toBe(201);
    expect(seed.body.created).toBe(3);
    expect(seed.body.invoices).toHaveLength(3);
    const flow = (seed.body.invoices as Array<{ id: string; invoice_number: string; status: string }>).find(
      (i) => i.invoice_number === "INV-FLOW-001"
    )!;
    expect(flow.status).toBe("open");

    // Reseed is a no-op for existing numbers.
    const again = await request(app)
      .post("/api/integrations/tally/ewaybill/seed-fresh")
      .set("Authorization", `Bearer ${user.token}`)
      .send({});
    expect(again.body.created).toBe(0);
    expect(again.body.skipped).toBe(3);

    // 1. Push to Tally — simulated here (no live connector in test).
    const posted = await request(app)
      .post("/api/integrations/tally/ewaybill/simulate-post")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: flow.id });
    expect(posted.status).toBe(200);
    expect(posted.body.status).toBe("COMPLETED");
    expect(posted.body.tallyReference).toBe("INV-FLOW-001");
    expect(posted.body.simulated).toBe(true);

    // Posting twice changes nothing.
    const repost = await request(app)
      .post("/api/integrations/tally/ewaybill/simulate-post")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: flow.id });
    expect(repost.body.tallyVoucherNumber).toBe(posted.body.tallyVoucherNumber);

    // 2. IRN generates through the mock IRP (nothing hardcoded).
    const irnRes = await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: flow.id });
    expect(irnRes.status).toBe(201);
    expect(irnRes.body.irn).toMatch(/^[0-9A-F]{64}$/);

    // 3. EWB mints a fresh random 12-digit number (only the vehicle is sent —
    // the rest comes from the persisted dispatch snapshot).
    const ewbRes = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: flow.id, dispatch: { vehicleNumber: "GJ01XY9876" } });
    expect(ewbRes.status).toBe(201);
    expect(ewbRes.body.ewayBillNumber).toMatch(/^\d{12}$/);
    expect(ewbRes.body.ewayBillStatus).toBe("EWB_GENERATED");
    expect(ewbRes.body.dispatchStatus).toBe("DISPATCH_RELEASED");
    expect(ewbRes.body.inventoryStatus).toBe("INVENTORY_DEDUCTED");
    expect(ewbRes.body.generatedDate).toBe(today());

    // 4. A second transaction mints a DIFFERENT number — nothing is reused.
    const flow2 = (seed.body.invoices as Array<{ id: string; invoice_number: string }>).find(
      (i) => i.invoice_number === "INV-FLOW-003"
    )!;
    await request(app)
      .post("/api/integrations/tally/ewaybill/simulate-post")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: flow2.id });
    await request(app)
      .post("/api/integrations/tally/irn/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: flow2.id });
    const ewb2 = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: flow2.id, dispatch: { vehicleNumber: "DL08AB1234" } });
    expect(ewb2.status).toBe(201);
    expect(ewb2.body.ewayBillNumber).toMatch(/^\d{12}$/);
    expect(ewb2.body.ewayBillNumber).not.toBe(ewbRes.body.ewayBillNumber);
    // 1400 km → 7 days validity from today.
    const plus7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    expect(ewb2.body.validUntil).toBe(plus7);
  });

  it("target flow: queue REQUEST_EWAYBILL → connector poll → ack → EWB_GENERATED", async () => {
    const { invoiceId, connectorId, companyId, accessToken } = await irnVerifiedInvoice(
      "INV-EWB-Q", "Phase6 Queue Co", "Phase6 Queue Customer"
    );

    const queued = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, dispatch: DISPATCH, mode: "queue", connectorId, companyId });
    expect(queued.status).toBe(202);
    expect(queued.body.ewayBillStatus).toBe("EWB_SUBMITTED");
    expect(queued.body.ewayBillNumber).toBeNull();
    expect(queued.body.dispatchStatus).toBe("DISPATCH_PENDING");
    const commandId = queued.body.commandId as string;
    expect(commandId).toBeTruthy();

    // Connector polls and receives the REQUEST_EWAYBILL command.
    const pending = await request(app)
      .get("/api/integrations/tally/commands/pending")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(pending.status).toBe(200);
    const found = (pending.body.commands as any[]).find((c) => c.id === commandId);
    expect(found).toBeTruthy();
    expect(found.command).toBe("REQUEST_EWAYBILL");
    expect(found.payload.ewb.invoiceNumber).toBe("INV-EWB-Q");
    expect(found.payload.ewb.tallyReference).toBe("INV-EWB-Q");
    expect(found.payload.ewb.irn).toBeTruthy();
    expect(String(found.payload.ewb.idempotencyKey)).toMatch(/^ewb:/);

    // Connector submits via its adapter and acks the generated result.
    const ack = await request(app)
      .post("/api/integrations/tally/commands/ack")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        commandId,
        status: "DONE",
        result: {
          outcome: "synced",
          adapterStatus: "SUCCESS",
          invoiceId,
          invoiceNumber: "INV-EWB-Q",
          ewayBillNumber: "TEST-EWB-101",
          generatedDate: "2026-10-13",
          validUntil: "2026-10-15",
          vehicleNumber: "KA01AB1234",
          requestId: found.payload.ewb.requestId,
          idempotencyKey: found.payload.ewb.idempotencyKey,
        },
      });
    expect(ack.status).toBe(200);

    const st = await request(app)
      .get(`/api/integrations/tally/ewaybill/status/${invoiceId}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(st.body.ewayBillStatus).toBe("EWB_GENERATED");
    expect(st.body.ewayBillNumber).toBe("TEST-EWB-101");
    expect(st.body.dispatchStatus).toBe("DISPATCH_RELEASED");
    expect(st.body.inventoryStatus).toBe("INVENTORY_DEDUCTED");
    expect(st.body.environment).toBe("MOCK");
    expect(st.body.legallyValid).toBe(false);
  });

  it("target flow: connector failure ack blocks, retryable stays retryable", async () => {
    const q1 = await irnVerifiedInvoice("INV-EWB-QF", "Phase6 QFail Co", "Phase6 QFail Customer");
    const queued = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: q1.invoiceId, dispatch: DISPATCH, mode: "queue", connectorId: q1.connectorId, companyId: q1.companyId });
    expect(queued.status).toBe(202);

    const ackFail = await request(app)
      .post("/api/integrations/tally/commands/ack")
      .set("Authorization", `Bearer ${q1.accessToken}`)
      .send({
        commandId: queued.body.commandId,
        status: "CANCELLED",
        result: {
          outcome: "failed",
          adapterStatus: "REJECTED",
          invoiceId: q1.invoiceId,
          errorCode: "INVALID_VEHICLE",
          errorMessage: "Vehicle number is invalid",
        },
      });
    expect(ackFail.status).toBe(200);
    const failed = await request(app)
      .get(`/api/integrations/tally/ewaybill/status/${q1.invoiceId}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(failed.body.ewayBillStatus).toBe("EWB_FAILED");
    expect(failed.body.ewayBillNumber).toBeNull();
    expect(failed.body.dispatchStatus).toBe("DISPATCH_BLOCKED");
    expect(failed.body.inventoryStatus).toBe("INVENTORY_NOT_DEDUCTED");

    // A late failure ack never regresses an already-generated invoice.
    const q2 = await irnVerifiedInvoice("INV-EWB-QR", "Phase6 QRetry Co", "Phase6 QRetry Customer");
    const queued2 = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId: q2.invoiceId, dispatch: DISPATCH, mode: "queue", connectorId: q2.connectorId, companyId: q2.companyId });
    await request(app)
      .post("/api/integrations/tally/commands/ack")
      .set("Authorization", `Bearer ${q2.accessToken}`)
      .send({
        commandId: queued2.body.commandId,
        status: "DONE",
        result: {
          outcome: "failed",
          adapterStatus: "RETRYABLE_ERROR",
          invoiceId: q2.invoiceId,
          errorCode: "EWB_SERVICE_UNAVAILABLE",
          errorMessage: "E-way bill service temporarily unavailable",
          retryable: true,
        },
      });
    const retryable = await request(app)
      .get(`/api/integrations/tally/ewaybill/status/${q2.invoiceId}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(retryable.body.ewayBillStatus).toBe("EWB_RETRYABLE");
    expect(retryable.body.ewayBillNumber).toBeNull();
    expect(retryable.body.dispatchStatus).toBe("DISPATCH_BLOCKED");
  });

  it("queue mode requires a connector and company", async () => {
    const { invoiceId } = await irnVerifiedInvoice("INV-EWB-QV", "Phase6 QVal Co", "Phase6 QVal Customer");
    const res = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, dispatch: DISPATCH, mode: "queue" });
    expect(res.status).toBe(400);

    const bad = await request(app)
      .post("/api/integrations/tally/ewaybill/request")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ invoiceId, dispatch: DISPATCH, mode: "queue", connectorId: "nope", companyId: "nope" });
    expect(bad.status).toBe(404);
  });

  it("invoice PDF is available only after generation", async () => {
    const { invoiceId } = await irnVerifiedInvoice("INV-EWB-NOPDF", "Phase6 NoPdf Co", "Phase6 NoPdf Customer");
    const early = await request(app)
      .get(`/api/integrations/tally/ewaybill/invoice-pdf/${invoiceId}`)
      .set("Authorization", `Bearer ${user.token}`);
    expect(early.status).toBe(400);
  });
});
