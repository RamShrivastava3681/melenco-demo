import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { requireAuth } from "../../../middleware/auth.js";
import { sendWzError } from "../whizunik/auth.js";
import { formatWzIssues } from "../whizunik/validate.js";
import {
  getCustomer,
  getProduct,
  getInvoice,
  updateInvoice,
  listInvoices,
  findCustomerByName,
  createCustomer,
  findInvoiceByNumber,
  createInvoice,
} from "../../../db/storesCore.js";
import { listAuditForUser } from "../../../db/storesTally.js";
import {
  createWCommand,
  getWConnectorByPublicId,
  getWCompany,
} from "../../../db/storesWhizunik.js";
import {
  getConnectorByPublicId as getLegacyConnector,
  getCompany as getLegacyCompany,
  createSyncCommand,
} from "../../../db/storesTally.js";
import { audit, type AuditEvent } from "../services/audit.service.js";
import {
  IRN_STATUSES,
  MockIRNAdapter,
  ProductionIRNAdapter,
  formatPreflightError,
  irnIdempotencyKey,
  irnStatusForResponse,
  preflightIrn,
  type IrnRequest,
  type IRNAdapter,
  type MockIrpMode,
} from "../services/irn.service.js";

const router = Router();

/**
 * Phase 5: IRN generation through Tally (mock IRP — test results only).
 *
 *   POST /irn/request      — preflight + submit + store (JWT auth)
 *   POST /irn/retry        — resubmit a FAILED / RETRYABLE / SUBMITTED IRN
 *   GET  /irn/status/:id   — linked WhizUnik ↔ Tally ↔ IRN view
 *   GET  /irn/audit        — IRN audit history (?invoiceId=, ?limit=)
 *
 * TEST-IRN-001 responses are mock results, never legally valid IRNs.
 * Every response carries `testMode: true` while the mock adapter is active.
 */

const complianceSchema = z.object({
  sellerGstin: z.string().trim().max(15).optional(),
  buyerGstin: z.string().trim().max(15).optional().nullable(),
  billingAddress: z.string().trim().max(500).optional(),
  shippingAddress: z.string().trim().max(500).optional(),
  placeOfSupply: z.string().trim().max(100).optional(),
  skuCode: z.string().trim().max(100).optional(),
  description: z.string().trim().max(500).optional(),
  hsn: z.string().trim().max(8).optional(),
  quantity: z.number().finite().positive().max(1_000_000).optional(),
  unit: z.string().trim().max(40).optional(),
  unitPrice: z.number().finite().nonnegative().max(1_000_000_000).optional(),
  taxableValue: z.number().finite().nonnegative().max(1_000_000_000).optional(),
  gstRate: z.number().finite().min(0).max(100).optional(),
  cgst: z.number().finite().nonnegative().max(1_000_000_000).optional(),
  sgst: z.number().finite().nonnegative().max(1_000_000_000).optional(),
  igst: z.number().finite().nonnegative().max(1_000_000_000).optional(),
  cess: z.number().finite().nonnegative().max(1_000_000_000).optional(),
  grandTotal: z.number().finite().positive().max(1_000_000_000).optional(),
  supplyType: z.string().trim().max(20).optional(),
  documentType: z.string().trim().max(20).optional(),
});

const requestSchema = z.object({
  invoiceId: z.string().trim().min(1).max(128),
  compliance: complianceSchema.optional().default({}),
  mockMode: z.enum(["SUCCESS", "REJECTED", "RETRYABLE_ERROR", "DUPLICATE"]).optional(),
  // Target flow: "queue" writes a REQUEST_IRN command for the connector
  // (verify voucher → build request → submit → ack back). "direct" runs the
  // same pipeline inline in the cloud (demo/testing without a connector).
  mode: z.enum(["direct", "queue"]).optional().default("direct"),
  connectorId: z.string().trim().min(1).max(120).optional(),
  companyId: z.string().trim().min(1).max(128).optional(),
});

const retrySchema = z.object({
  invoiceId: z.string().trim().min(1).max(128),
  mockMode: z.enum(["SUCCESS", "REJECTED", "RETRYABLE_ERROR", "DUPLICATE"]).optional(),
});

type Compliance = z.infer<typeof complianceSchema>;

function selectAdapter(mockMode?: MockIrpMode): IRNAdapter {
  if ((process.env.IRN_ADAPTER ?? "mock").toLowerCase() === "production") {
    return new ProductionIRNAdapter();
  }
  return new MockIRNAdapter(mockMode ?? "AUTO");
}

interface LinkedIrnView {
  whizunikInvoiceId: string;
  whizunikInvoiceNumber: string;
  tallyVoucherNumber: string | null;
  tallyReference: string | null;
  irn: string | null;
  acknowledgementNumber: string | null;
  acknowledgementDate: string | null;
  irnStatus: string;
  irnRequestId: string | null;
  irnGeneratedAt: string | null;
  duplicate: boolean;
  testMode: boolean;
}

function toLinkedView(inv: Record<string, unknown>, duplicate: boolean, testMode: boolean): LinkedIrnView {
  return {
    whizunikInvoiceId: String(inv.id ?? ""),
    whizunikInvoiceNumber: String(inv.invoice_number ?? ""),
    tallyVoucherNumber: (inv.tally_voucher_number as string) ?? null,
    tallyReference: (inv.tally_reference as string) ?? null,
    irn: (inv.irn as string) ?? null,
    acknowledgementNumber: (inv.acknowledgementNumber as string) ?? null,
    acknowledgementDate: (inv.acknowledgementDate as string) ?? null,
    irnStatus: String(inv.irnStatus ?? "IRN_PENDING"),
    irnRequestId: (inv.irnRequestId as string) ?? null,
    irnGeneratedAt: (inv.irnGeneratedAt as string) ?? null,
    duplicate,
    testMode,
  };
}

/**
 * Audit helper (§10). Every IRN log carries the invoice ID + number, Tally
 * voucher number + reference, request ID, IRN status and timestamp
 * (created_at). Financial addresses and secrets are never logged.
 */
function irnAudit(
  event: AuditEvent,
  ctx: {
    userId: string;
    invoiceId: string;
    invoiceNumber: string;
    tallyVoucherNumber: string | null;
    tallyReference: string | null;
    requestId: string;
    irnStatus: string;
    extra?: Record<string, unknown>;
  }
): void {
  audit(event, {
    userId: ctx.userId,
    requestId: ctx.requestId,
    detail: {
      whizunikInvoiceId: ctx.invoiceId,
      whizunikInvoiceNumber: ctx.invoiceNumber,
      tallyVoucherNumber: ctx.tallyVoucherNumber,
      tallyReference: ctx.tallyReference,
      irnStatus: ctx.irnStatus,
      ...(ctx.extra ?? {}),
    },
  });
}

const str = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s ? s : null;
};

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface AssembledData {
  ineligible?: { missingField: string; action: string };
  sellerGstin: string | null;
  buyerGstin: string | null;
  buyerName: string | null;
  billingAddress: string | null;
  shippingAddress: string | null;
  placeOfSupply: string | null;
  skuCode: string | null;
  description: string | null;
  hsn: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  taxableValue: number | null;
  gstRate: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  cess: number | null;
  grandTotal: number | null;
  supplyType: string;
  documentType: string;
}

/**
 * Assemble the IRN dataset from the verified voucher: invoice (posted to
 * Tally) + customer + product, with explicit compliance overrides merged in.
 * Overrides are persisted to the invoice so "complete the details and retry"
 * works across calls.
 */
async function assembleData(
  userId: string,
  inv: Record<string, unknown>,
  compliance: Compliance
): Promise<{ data: AssembledData; persisted: Record<string, unknown> }> {
  const c = compliance ?? {};
  const persisted: Record<string, unknown> = {};

  // Persist any caller-supplied compliance details onto the invoice snapshot.
  const persistMap: Record<keyof Compliance, string> = {
    sellerGstin: "seller_gstin",
    buyerGstin: "buyer_gstin",
    billingAddress: "billing_address",
    shippingAddress: "shipping_address",
    placeOfSupply: "place_of_supply",
    skuCode: "sku_code",
    description: "line_description",
    hsn: "hsn",
    quantity: "quantity",
    unit: "unit",
    unitPrice: "unit_price",
    taxableValue: "taxable_value",
    gstRate: "gst_rate",
    cgst: "cgst",
    sgst: "sgst",
    igst: "igst",
    cess: "cess",
    grandTotal: "grand_total",
    supplyType: "supply_type",
    documentType: "document_type",
  };
  for (const [from, to] of Object.entries(persistMap)) {
    const v = (c as Record<string, unknown>)[from];
    if (v !== undefined) persisted[to] = v;
  }
  let merged: Record<string, unknown> = { ...inv, ...persisted };

  const customerId = String(inv.customer_id ?? "");
  const customer = customerId ? await getCustomer(userId, customerId).catch(() => undefined) : undefined;
  const skuId = merged.sku_id ?? merged.skuId ?? null;
  const product =
    skuId !== null && skuId !== undefined
      ? await getProduct(userId, String(skuId)).catch(() => undefined)
      : undefined;

  // --- Preconditions (§Preconditions): verified Tally voucher required ---
  if (String(inv.status ?? "") !== "COMPLETED") {
    return {
      data: { ineligible: { missingField: "Tally voucher", action: "Post the invoice to Tally first (invoice must be COMPLETED) and retry." } } as AssembledData,
      persisted: {},
    };
  }
  const tallyVoucherNumber = str(merged.tally_voucher_number);
  const tallyReference = str(merged.tally_reference);
  if (!tallyVoucherNumber) {
    return {
      data: { ineligible: { missingField: "Tally voucher number", action: "Re-sync the voucher so the Tally voucher number is captured, then retry." } } as AssembledData,
      persisted: {},
    };
  }
  if (!tallyReference) {
    return {
      data: { ineligible: { missingField: "Tally reference", action: "Re-sync the voucher so the Tally reference is captured, then retry." } } as AssembledData,
      persisted: {},
    };
  }

  // --- Field assembly (verified data first, overrides fill gaps) ---
  const sellerGstin = str(merged.seller_gstin ?? merged.sellerGstin);
  const buyerGstin = str(merged.buyer_gstin ?? merged.buyerGstin ?? customer?.gstin);
  const buyerName = str(customer?.name);
  const billingAddress = str(merged.billing_address ?? merged.billingAddress ?? customer?.address);
  const shippingAddress = str(merged.shipping_address ?? merged.shippingAddress);
  const placeOfSupply = str(merged.place_of_supply ?? merged.placeOfSupply);
  const skuCode = str(merged.sku_code ?? merged.skuCode ?? product?.sku_code ?? product?.name);
  const description = str(merged.line_description ?? merged.description ?? product?.description);
  const hsn = str(merged.hsn ?? product?.hsn);
  const quantity = numOrNull(merged.quantity ?? merged.qty);
  const unit = str(merged.unit ?? merged.base_unit ?? product?.base_unit);
  const unitPrice = numOrNull(merged.unit_price ?? merged.unitPrice);
  const gstRate = numOrNull(merged.gst_rate ?? merged.gstRate);
  let taxableValue = numOrNull(merged.taxable_value ?? merged.taxableValue);
  if (taxableValue === null && quantity !== null && unitPrice !== null) {
    taxableValue = round2(quantity * unitPrice);
    persisted.taxable_value = taxableValue;
  }
  // Deterministic intra-state split when the voucher carries no tax split.
  // Explicit splits are validated as-is (never silently corrected).
  let cgst = numOrNull(merged.cgst);
  let sgst = numOrNull(merged.sgst);
  let igst = numOrNull(merged.igst);
  if (cgst === null && sgst === null && igst === null && taxableValue !== null && gstRate !== null) {
    const half = round2((taxableValue * gstRate) / 200);
    cgst = half;
    sgst = half;
    igst = 0;
    persisted.cgst = cgst;
    persisted.sgst = sgst;
    persisted.igst = igst;
  }
  const cess = numOrNull(merged.cess) ?? 0;
  if (numOrNull(merged.cess) === null) persisted.cess = 0;
  const grandTotal = numOrNull(merged.grand_total ?? merged.grandTotal ?? merged.amount);

  if (Object.keys(persisted).length > 0) {
    await updateInvoice(userId, String(inv.id), persisted);
    merged = { ...merged, ...persisted };
  }

  return {
    data: {
      sellerGstin,
      buyerGstin,
      buyerName,
      billingAddress,
      shippingAddress,
      placeOfSupply,
      skuCode,
      description,
      hsn,
      quantity,
      unit,
      unitPrice,
      taxableValue,
      gstRate,
      cgst,
      sgst,
      igst,
      cess,
      grandTotal,
      supplyType: str(merged.supply_type ?? merged.supplyType) ?? (buyerGstin ? "B2B" : "B2C"),
      documentType: str(merged.document_type ?? merged.documentType) ?? "INV",
    },
    persisted,
  };
}

function toPreflightInput(
  data: AssembledData,
  inv: Record<string, unknown>
): Parameters<typeof preflightIrn>[0] {
  return {
    sellerGstin: data.sellerGstin,
    buyerGstin: data.buyerGstin,
    buyerName: data.buyerName,
    billingAddress: data.billingAddress,
    invoiceNumber: String(inv.invoice_number ?? ""),
    invoiceDate: String(inv.issue_date ?? "").slice(0, 10),
    voucherExistsInTally: true, // gated by COMPLETED + captured refs above
    tallyReference: str(inv.tally_reference),
    hsn: data.hsn,
    quantity: data.quantity,
    unitPrice: data.unitPrice,
    taxableValue: data.taxableValue,
    gstRate: data.gstRate,
    cgst: data.cgst,
    sgst: data.sgst,
    igst: data.igst,
    cess: data.cess,
    grandTotal: data.grandTotal,
    placeOfSupply: data.placeOfSupply,
    alreadyHasIrn: !!str(inv.irn),
    tallyVoucherNumber: str(inv.tally_voucher_number),
  };
}

function buildIrnRequest(
  data: AssembledData,
  inv: Record<string, unknown>,
  requestId: string,
  testMode: boolean
): IrnRequest {
  const invoiceDate = String(inv.issue_date ?? "").slice(0, 10);
  const sellerGstin = String(data.sellerGstin ?? "").trim().toUpperCase();
  const invoiceNumber = String(inv.invoice_number ?? "").trim();
  return {
    whizunikInvoiceId: String(inv.id ?? ""),
    whizunikInvoiceNumber: invoiceNumber,
    tallyVoucherNumber: String(inv.tally_voucher_number ?? ""),
    tallyReference: String(inv.tally_reference ?? ""),
    invoiceDate,
    sellerGstin,
    buyerGstin: data.buyerGstin ? String(data.buyerGstin).trim().toUpperCase() : null,
    buyerName: String(data.buyerName ?? ""),
    billingAddress: data.billingAddress,
    shippingAddress: data.shippingAddress,
    placeOfSupply: data.placeOfSupply,
    items: [
      {
        skuCode: data.skuCode,
        description: data.description,
        hsn: data.hsn ? String(data.hsn).trim() : null,
        quantity: data.quantity,
        unit: data.unit,
        taxableValue: data.taxableValue,
        gstRate: data.gstRate,
        cgst: data.cgst,
        sgst: data.sgst,
        igst: data.igst,
        cess: data.cess,
      },
    ],
    invoiceTotal: data.grandTotal,
    supplyType: data.supplyType,
    documentType: data.documentType,
    idempotencyKey: irnIdempotencyKey(sellerGstin, invoiceNumber, invoiceDate),
    requestId,
    testMode,
  };
}

/** Duplicate protection (§8): existing IRN on this invoice or the same idempotency key. */
async function findDuplicateIrn(
  userId: string,
  invoiceId: string,
  idempotencyKey: string
): Promise<Record<string, unknown> | null> {
  const rows = await listInvoices(userId);
  // 1. This invoice already carries an IRN.
  const self = rows.find((r) => String(r.id) === invoiceId && str(r.irn));
  if (self) return self as Record<string, unknown>;
  // 2. Same seller + number + date already produced an IRN.
  const other = rows.find(
    (r) => String(r.id) !== invoiceId && String(r.irn_idempotency_key ?? "") === idempotencyKey && str(r.irn)
  );
  if (other) return other as Record<string, unknown>;
  return null;
}

// ---------------------------------------------------------------------------
// Target flow: queue a REQUEST_IRN command for the connector
// ---------------------------------------------------------------------------

interface QueueIrnContext {
  userId: string;
  invoiceId: string;
  invoiceNumber: string;
  tallyVoucherNumber: string | null;
  tallyReference: string | null;
  connectorId?: string;
  companyId?: string;
  mockMode?: "SUCCESS" | "REJECTED" | "RETRYABLE_ERROR" | "DUPLICATE";
  testMode: boolean;
  data: AssembledData;
  inv: Record<string, unknown>;
  irnRequest: IrnRequest;
  requestId: string;
}

/**
 * Queue mode: the cloud never touches the IRP. The verified IRN dataset
 * travels to the paired connector as a REQUEST_IRN command; the connector
 * verifies the Tally voucher, rebuilds the request, submits via its own
 * adapter and acks the result back (applied by applyIrnAck).
 */
async function queueIrnCommand(res: Response, ctx: QueueIrnContext): Promise<void> {
  const { userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference } = ctx;
  if (!ctx.connectorId || !ctx.companyId) {
    sendWzError(res, "INVALID_PAYLOAD", "connectorId and companyId are required in queue mode");
    return;
  }

  // Resolve connector (new-spec first, legacy tc_* fallback).
  let target: { kind: "whizunik"; connectorId: string } | { kind: "legacy"; rowId: string; connectorId: string } | null = null;
  const conn = await getWConnectorByPublicId(ctx.connectorId);
  if (conn && conn.tenant_id === userId) {
    target = { kind: "whizunik", connectorId: conn.connector_id as string };
  } else {
    try {
      const legacy = await getLegacyConnector(ctx.connectorId);
      if (legacy && legacy.user_id === userId) {
        target = { kind: "legacy", rowId: legacy.id as string, connectorId: legacy.connector_id as string };
      }
    } catch { /* legacy table may not exist */ }
  }
  if (!target) {
    sendWzError(res, "INVALID_COMPANY", "Connector not found for this account");
    return;
  }

  // Resolve company (new-spec or legacy tally_companies).
  let companyName = "";
  let tallyGuid: string | null = null;
  const wco = await getWCompany(ctx.companyId);
  if (wco) {
    companyName = (wco.name as string) ?? "";
    tallyGuid = (wco.tally_guid as string) ?? null;
  } else {
    try {
      const legacyCo = await getLegacyCompany(userId, ctx.companyId);
      if (!legacyCo) {
        sendWzError(res, "INVALID_COMPANY", "Company not found for this account");
        return;
      }
      companyName = (legacyCo.tally_company_name as string) ?? "";
      tallyGuid = (legacyCo.tally_company_guid as string) ?? null;
    } catch {
      sendWzError(res, "INVALID_COMPANY", "Company not found for this account");
      return;
    }
  }

  const d = ctx.data;
  const id = `cmd_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
  const payload = {
    companyId: ctx.companyId,
    companyName,
    tallyCompanyGuid: tallyGuid,
    connectorId: target.connectorId,
    irn: {
      invoiceId: ctx.invoiceId,
      invoiceNumber: String(ctx.inv.invoice_number ?? ""),
      invoiceDate: String(ctx.inv.issue_date ?? "").slice(0, 10),
      tallyVoucherNumber: String(ctx.inv.tally_voucher_number ?? ""),
      tallyReference: String(ctx.inv.tally_reference ?? ""),
      buyerName: d.buyerName,
      sellerGstin: d.sellerGstin,
      buyerGstin: d.buyerGstin,
      billingAddress: d.billingAddress,
      shippingAddress: d.shippingAddress,
      placeOfSupply: d.placeOfSupply,
      skuCode: d.skuCode,
      description: d.description,
      hsn: d.hsn,
      quantity: d.quantity,
      unit: d.unit,
      unitPrice: d.unitPrice,
      taxableValue: d.taxableValue,
      gstRate: d.gstRate,
      cgst: d.cgst,
      sgst: d.sgst,
      igst: d.igst,
      cess: d.cess,
      grandTotal: d.grandTotal,
      supplyType: d.supplyType,
      documentType: d.documentType,
      idempotencyKey: ctx.irnRequest.idempotencyKey,
      requestId: ctx.requestId,
    },
    // Test hook: forwarded so E2E retry paths work through the connector.
    ...(ctx.mockMode ? { mockMode: ctx.mockMode } : {}),
  };

  if (target.kind === "whizunik") {
    await createWCommand({
      id,
      tenant_id: userId,
      connector_id: target.connectorId,
      command: "REQUEST_IRN",
      payload: JSON.stringify(payload),
    });
  } else {
    await createSyncCommand({
      id,
      user_id: userId,
      connector_id: target.rowId,
      command: "REQUEST_IRN",
      payload: JSON.stringify(payload),
    });
  }

  await updateInvoice(userId, invoiceId, {
    irnStatus: "IRN_SUBMITTED",
    irnRequestId: ctx.requestId,
    irn_idempotency_key: ctx.irnRequest.idempotencyKey,
    connector_id: target.connectorId,
    push_command_id: id,
  });
  irnAudit("IRN_REQUEST_CREATED", {
    userId,
    invoiceId,
    invoiceNumber,
    tallyVoucherNumber,
    tallyReference,
    requestId: ctx.requestId,
    irnStatus: "IRN_REQUEST_READY",
    extra: { idempotencyKey: ctx.irnRequest.idempotencyKey },
  });
  irnAudit("IRN_SUBMITTED", {
    userId,
    invoiceId,
    invoiceNumber,
    tallyVoucherNumber,
    tallyReference,
    requestId: ctx.requestId,
    irnStatus: "IRN_SUBMITTED",
    extra: { commandId: id, connectorId: target.connectorId },
  });

  const fresh = ((await getInvoice(userId, invoiceId)) ?? ctx.inv) as Record<string, unknown>;
  res.status(202).json({
    ...toLinkedView(fresh, false, ctx.testMode),
    commandId: id,
    message: "IRN request queued for the connector. The IRN lands on the invoice when the connector acks the result.",
  });
}

// ---------------------------------------------------------------------------
// POST /irn/request
// ---------------------------------------------------------------------------

router.post("/irn/request", requireAuth, async (req: Request, res: Response) => {
  const parsed = requestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
    return;
  }
  try {
    const userId = req.user!.userId;
    const { invoiceId, compliance, mockMode, mode, connectorId, companyId } = parsed.data;

    const inv = (await getInvoice(userId, invoiceId)) as Record<string, unknown> | undefined;
    if (!inv) {
      sendWzError(res, "INVALID_PAYLOAD", "Invoice not found for this account");
      return;
    }
    const invoiceNumber = String(inv.invoice_number ?? "");
    const tallyVoucherNumber = str(inv.tally_voucher_number);
    const tallyReference = str(inv.tally_reference);
    const requestId = `irn_${uuidv4().replace(/-/g, "").slice(0, 16)}`;

    irnAudit("IRN_PREFLIGHT_STARTED", {
      userId,
      invoiceId,
      invoiceNumber,
      tallyVoucherNumber,
      tallyReference,
      requestId,
      irnStatus: String(inv.irnStatus ?? "IRN_PENDING"),
    });

    // Duplicate protection first (§8.1): an invoice that already has an IRN
    // never submits a second request — return the existing IRN as-is.
    if (str(inv.irn)) {
      const existingAdapter = selectAdapter(mockMode);
      res.status(200).json({
        ...toLinkedView(inv, true, existingAdapter.testMode),
        message: "IRN already exists. Returning the existing IRN — no second request submitted.",
      });
      return;
    }

    const { data } = await assembleData(userId, inv, compliance ?? {});
    if (data.ineligible) {
      irnAudit("IRN_PREFLIGHT_FAILED", {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        requestId,
        irnStatus: String(inv.irnStatus ?? "IRN_PENDING"),
        extra: { missingField: data.ineligible.missingField },
      });
      res.status(422).json({
        error: "IRN cannot be requested.",
        missingField: data.ineligible.missingField,
        action: data.ineligible.action,
        failures: [{ missingField: data.ineligible.missingField, action: data.ineligible.action }],
      });
      return;
    }

    const preflight = preflightIrn(toPreflightInput(data, inv));
    if (!preflight.ok) {
      irnAudit("IRN_PREFLIGHT_FAILED", {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        requestId,
        irnStatus: String(inv.irnStatus ?? "IRN_PENDING"),
        extra: { missingField: preflight.failures[0]?.missingField ?? null },
      });
      res.status(422).json({
        error: formatPreflightError(preflight),
        missingField: preflight.failures[0]?.missingField ?? null,
        action: preflight.failures[0]?.action ?? null,
        failures: preflight.failures,
      });
      return;
    }

    irnAudit("IRN_PREFLIGHT_PASSED", {
      userId,
      invoiceId,
      invoiceNumber,
      tallyVoucherNumber,
      tallyReference,
      requestId,
      irnStatus: "IRN_REQUEST_READY",
    });
    await updateInvoice(userId, invoiceId, { irnStatus: "IRN_REQUEST_READY" });

    const adapter = selectAdapter(mockMode);
    const irnRequest = buildIrnRequest(data, inv, requestId, adapter.testMode);

    // Duplicate protection before submission (§8).
    const dup = await findDuplicateIrn(userId, invoiceId, irnRequest.idempotencyKey);
    if (dup) {
      const view = toLinkedView(dup.id === invoiceId ? { ...inv, ...dup } : dup, true, adapter.testMode);
      res.status(200).json({ ...view, message: "IRN already exists. Returning the existing IRN — no second request submitted." });
      return;
    }

    // Target flow (queue mode): hand the verified request to the connector
    // as a REQUEST_IRN command. The connector verifies the Tally voucher,
    // rebuilds the request, submits via its adapter and acks the result —
    // the IRN lands on the invoice via applyIrnAck, never inline here.
    if (mode === "queue") {
      await queueIrnCommand(res, {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        connectorId,
        companyId,
        mockMode,
        testMode: adapter.testMode,
        data,
        inv,
        irnRequest,
        requestId,
      });
      return;
    }

    irnAudit("IRN_REQUEST_CREATED", {
      userId,
      invoiceId,
      invoiceNumber,
      tallyVoucherNumber,
      tallyReference,
      requestId,
      irnStatus: "IRN_REQUEST_READY",
      extra: { idempotencyKey: irnRequest.idempotencyKey },
    });
    await updateInvoice(userId, invoiceId, {
      irnStatus: "IRN_SUBMITTED",
      irnRequestId: requestId,
      irn_idempotency_key: irnRequest.idempotencyKey,
    });
    irnAudit("IRN_SUBMITTED", {
      userId,
      invoiceId,
      invoiceNumber,
      tallyVoucherNumber,
      tallyReference,
      requestId,
      irnStatus: "IRN_SUBMITTED",
      extra: { adapter: adapter.name },
    });

    let adapterResponse;
    try {
      adapterResponse = await adapter.submit(irnRequest);
    } catch (err) {
      // Production adapter not configured (government access unavailable).
      await updateInvoice(userId, invoiceId, {
        irnStatus: "IRN_RETRYABLE",
        irnErrorCode: "ADAPTER_NOT_CONFIGURED",
        irnErrorMessage: err instanceof Error ? err.message : String(err),
      });
      irnAudit("IRN_RETRYABLE_FAILURE", {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        requestId,
        irnStatus: "IRN_RETRYABLE",
        extra: { errorCode: "ADAPTER_NOT_CONFIGURED" },
      });
      sendWzError(res, "SERVER_ERROR", err instanceof Error ? err.message : "IRN adapter unavailable");
      return;
    }

    irnAudit("IRN_RESPONSE_RECEIVED", {
      userId,
      invoiceId,
      invoiceNumber,
      tallyVoucherNumber,
      tallyReference,
      requestId,
      irnStatus: irnStatusForResponse(adapterResponse),
      extra: {
        adapterStatus: adapterResponse.status,
        errorCode: adapterResponse.errorCode ?? null,
      },
    });

    const nextStatus = irnStatusForResponse(adapterResponse);
    if (adapterResponse.status === "SUCCESS" || adapterResponse.status === "DUPLICATE") {
      const now = new Date().toISOString();
      await updateInvoice(userId, invoiceId, {
        irnStatus: "IRN_GENERATED",
        irn: adapterResponse.irn ?? null,
        acknowledgementNumber: adapterResponse.ackNumber ?? null,
        acknowledgementDate: adapterResponse.ackDate ?? null,
        signedInvoice: adapterResponse.signedInvoice ?? null,
        signedQrCode: adapterResponse.signedQrCode ?? null,
        irnGeneratedAt: now,
        irnErrorCode: null,
        irnErrorMessage: null,
      });
      irnAudit("IRN_GENERATED", {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        requestId,
        irnStatus: "IRN_GENERATED",
        extra: { irn: adapterResponse.irn ?? null, ackNumber: adapterResponse.ackNumber ?? null },
      });
      irnAudit("IRN_RESULT_STORED", {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        requestId,
        irnStatus: "IRN_GENERATED",
      });
      const fresh = ((await getInvoice(userId, invoiceId)) ?? inv) as Record<string, unknown>;
      res.status(adapterResponse.status === "DUPLICATE" ? 200 : 201).json({
        ...toLinkedView(fresh, adapterResponse.status === "DUPLICATE", adapter.testMode),
        signedInvoice: adapterResponse.signedInvoice ?? null,
        signedQrCode: adapterResponse.signedQrCode ?? null,
      });
      return;
    }

    if (adapterResponse.status === "REJECTED") {
      await updateInvoice(userId, invoiceId, {
        irnStatus: "IRN_FAILED",
        irnErrorCode: adapterResponse.errorCode ?? null,
        irnErrorMessage: adapterResponse.errorMessage ?? null,
      });
      irnAudit("IRN_REJECTED", {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        requestId,
        irnStatus: "IRN_FAILED",
        extra: {
          errorCode: adapterResponse.errorCode ?? null,
          errorMessage: adapterResponse.errorMessage ?? null,
        },
      });
      irnAudit("IRN_RESULT_STORED", {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        requestId,
        irnStatus: "IRN_FAILED",
      });
      res.status(200).json({
        ...toLinkedView(
          ((await getInvoice(userId, invoiceId)) ?? inv) as Record<string, unknown>,
          false,
          adapter.testMode
        ),
        errorCode: adapterResponse.errorCode ?? null,
        errorMessage: adapterResponse.errorMessage ?? null,
      });
      return;
    }

    // RETRYABLE_ERROR — stays retryable, never marked generated.
    await updateInvoice(userId, invoiceId, {
      irnStatus: "IRN_RETRYABLE",
      irnErrorCode: adapterResponse.errorCode ?? null,
      irnErrorMessage: adapterResponse.errorMessage ?? null,
    });
    irnAudit("IRN_RETRYABLE_FAILURE", {
      userId,
      invoiceId,
      invoiceNumber,
      tallyVoucherNumber,
      tallyReference,
      requestId,
      irnStatus: "IRN_RETRYABLE",
      extra: {
        errorCode: adapterResponse.errorCode ?? null,
        errorMessage: adapterResponse.errorMessage ?? null,
      },
    });
    irnAudit("IRN_RESULT_STORED", {
      userId,
      invoiceId,
      invoiceNumber,
      tallyVoucherNumber,
      tallyReference,
      requestId,
      irnStatus: "IRN_RETRYABLE",
    });
    res.status(200).json({
      ...toLinkedView(
        ((await getInvoice(userId, invoiceId)) ?? inv) as Record<string, unknown>,
        false,
        adapter.testMode
      ),
      errorCode: adapterResponse.errorCode ?? null,
      errorMessage: adapterResponse.errorMessage ?? null,
    });
  } catch (err) {
    console.error("[irn][request] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

// ---------------------------------------------------------------------------
// POST /irn/retry — resubmit FAILED / RETRYABLE / SUBMITTED (restart-safe)
// ---------------------------------------------------------------------------

router.post("/irn/retry", requireAuth, async (req: Request, res: Response) => {
  const parsed = retrySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
    return;
  }
  try {
    const userId = req.user!.userId;
    const { invoiceId, mockMode } = parsed.data;
    const inv = (await getInvoice(userId, invoiceId)) as Record<string, unknown> | undefined;
    if (!inv) {
      sendWzError(res, "INVALID_PAYLOAD", "Invoice not found for this account");
      return;
    }
    const current = String(inv.irnStatus ?? "IRN_PENDING");
    // Only non-terminal states may be resubmitted. GENERATED / NOT_REQUIRED /
    // CANCELLED never resubmit (duplicate protection); PENDING / REQUEST_READY
    // must go through POST /irn/request first.
    if (!["IRN_FAILED", "IRN_RETRYABLE", "IRN_SUBMITTED"].includes(current)) {
      sendWzError(
        res,
        "INVALID_PAYLOAD",
        `Invoice IRN status is ${current} — only IRN_FAILED, IRN_RETRYABLE or IRN_SUBMITTED can be retried`
      );
      return;
    }
    if (str(inv.irn)) {
      const adapter = selectAdapter(mockMode);
      res.status(200).json({
        ...toLinkedView(inv, true, adapter.testMode),
        message: "IRN already exists. Returning the existing IRN — no second request submitted.",
      });
      return;
    }

    const invoiceNumber = String(inv.invoice_number ?? "");
    const tallyVoucherNumber = str(inv.tally_voucher_number);
    const tallyReference = str(inv.tally_reference);
    const requestId = `irn_${uuidv4().replace(/-/g, "").slice(0, 16)}`;

    irnAudit("IRN_PREFLIGHT_STARTED", {
      userId,
      invoiceId,
      invoiceNumber,
      tallyVoucherNumber,
      tallyReference,
      requestId,
      irnStatus: current,
    });

    const { data } = await assembleData(userId, inv, {});
    if (data.ineligible) {
      res.status(422).json({
        error: "IRN cannot be requested.",
        missingField: data.ineligible.missingField,
        action: data.ineligible.action,
      });
      return;
    }
    const preflight = preflightIrn(toPreflightInput(data, inv));
    if (!preflight.ok) {
      irnAudit("IRN_PREFLIGHT_FAILED", {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        requestId,
        irnStatus: current,
        extra: { missingField: preflight.failures[0]?.missingField ?? null },
      });
      res.status(422).json({
        error: formatPreflightError(preflight),
        missingField: preflight.failures[0]?.missingField ?? null,
        action: preflight.failures[0]?.action ?? null,
        failures: preflight.failures,
      });
      return;
    }

    const adapter = selectAdapter(mockMode);
    const irnRequest = buildIrnRequest(data, inv, requestId, adapter.testMode);
    const dup = await findDuplicateIrn(userId, invoiceId, irnRequest.idempotencyKey);
    if (dup) {
      res.status(200).json({
        ...toLinkedView(dup.id === invoiceId ? { ...inv, ...dup } : dup, true, adapter.testMode),
        message: "IRN already exists. Returning the existing IRN — no second request submitted.",
      });
      return;
    }

    await updateInvoice(userId, invoiceId, {
      irnStatus: "IRN_SUBMITTED",
      irnRequestId: requestId,
      irn_idempotency_key: irnRequest.idempotencyKey,
    });
    irnAudit("IRN_SUBMITTED", {
      userId,
      invoiceId,
      invoiceNumber,
      tallyVoucherNumber,
      tallyReference,
      requestId,
      irnStatus: "IRN_SUBMITTED",
      extra: { adapter: adapter.name, retry: true },
    });

    const adapterResponse = await adapter.submit(irnRequest);
    irnAudit("IRN_RESPONSE_RECEIVED", {
      userId,
      invoiceId,
      invoiceNumber,
      tallyVoucherNumber,
      tallyReference,
      requestId,
      irnStatus: irnStatusForResponse(adapterResponse),
      extra: { adapterStatus: adapterResponse.status, errorCode: adapterResponse.errorCode ?? null },
    });

    const nextStatus = irnStatusForResponse(adapterResponse);
    if (nextStatus === "IRN_GENERATED") {
      const now = new Date().toISOString();
      await updateInvoice(userId, invoiceId, {
        irnStatus: "IRN_GENERATED",
        irn: adapterResponse.irn ?? null,
        acknowledgementNumber: adapterResponse.ackNumber ?? null,
        acknowledgementDate: adapterResponse.ackDate ?? null,
        signedInvoice: adapterResponse.signedInvoice ?? null,
        signedQrCode: adapterResponse.signedQrCode ?? null,
        irnGeneratedAt: now,
        irnErrorCode: null,
        irnErrorMessage: null,
      });
      irnAudit("IRN_GENERATED", {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        requestId,
        irnStatus: "IRN_GENERATED",
        extra: { irn: adapterResponse.irn ?? null },
      });
      irnAudit("IRN_RESULT_STORED", {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        requestId,
        irnStatus: "IRN_GENERATED",
      });
    } else {
      await updateInvoice(userId, invoiceId, {
        irnStatus: nextStatus,
        irnErrorCode: adapterResponse.errorCode ?? null,
        irnErrorMessage: adapterResponse.errorMessage ?? null,
      });
      irnAudit(nextStatus === "IRN_FAILED" ? "IRN_REJECTED" : "IRN_RETRYABLE_FAILURE", {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        requestId,
        irnStatus: nextStatus,
        extra: { errorCode: adapterResponse.errorCode ?? null },
      });
      irnAudit("IRN_RESULT_STORED", {
        userId,
        invoiceId,
        invoiceNumber,
        tallyVoucherNumber,
        tallyReference,
        requestId,
        irnStatus: nextStatus,
      });
    }
    const fresh = ((await getInvoice(userId, invoiceId)) ?? inv) as Record<string, unknown>;
    res.status(200).json({
      ...toLinkedView(fresh, false, adapter.testMode),
      errorCode: adapterResponse.errorCode ?? null,
      errorMessage: adapterResponse.errorMessage ?? null,
    });
  } catch (err) {
    console.error("[irn][retry] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

// ---------------------------------------------------------------------------
// GET /irn/status/:invoiceId — linked WhizUnik ↔ Tally ↔ IRN view
// ---------------------------------------------------------------------------

router.get("/irn/status/:invoiceId", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const invoiceId = String(req.params.invoiceId ?? "");
    const inv = (await getInvoice(userId, invoiceId)) as Record<string, unknown> | undefined;
    if (!inv) {
      sendWzError(res, "INVALID_PAYLOAD", "Invoice not found for this account");
      return;
    }
    const testMode = (process.env.IRN_ADAPTER ?? "mock").toLowerCase() !== "production";
    res.status(200).json({
      ...toLinkedView(inv, false, testMode),
      invoiceStatus: String(inv.status ?? ""),
      signedInvoice: (inv.signedInvoice as string) ?? null,
      signedQrCode: (inv.signedQrCode as string) ?? null,
      errorCode: (inv.irnErrorCode as string) ?? null,
      errorMessage: (inv.irnErrorMessage as string) ?? null,
    });
  } catch (err) {
    console.error("[irn][status] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

// ---------------------------------------------------------------------------
// GET /irn/audit — IRN audit history
// ---------------------------------------------------------------------------

const IRN_EVENTS = new Set<string>([
  "IRN_PREFLIGHT_STARTED",
  "IRN_PREFLIGHT_PASSED",
  "IRN_PREFLIGHT_FAILED",
  "IRN_REQUEST_CREATED",
  "IRN_SUBMITTED",
  "IRN_RESPONSE_RECEIVED",
  "IRN_GENERATED",
  "IRN_REJECTED",
  "IRN_RETRYABLE_FAILURE",
  "IRN_RESULT_STORED",
]);

router.get("/irn/audit", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { invoiceId, limit } = req.query as Record<string, string | undefined>;
    const take = Math.min(Math.max(parseInt(limit || "50", 10) || 50, 1), 200);
    let rows = await listAuditForUser(userId, 500);
    rows = rows.filter((r) => IRN_EVENTS.has(String(r.event ?? "")));
    if (invoiceId) {
      rows = rows.filter((r) => {
        try {
          const d = JSON.parse(String(r.detail ?? "{}")) as { whizunikInvoiceId?: string };
          return d.whizunikInvoiceId === invoiceId;
        } catch {
          return false;
        }
      });
    }
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    res.status(200).json({
      events: rows.slice(0, take).map((r) => {
        let detail: unknown = null;
        try {
          detail = r.detail ? JSON.parse(String(r.detail)) : null;
        } catch {
          detail = r.detail;
        }
        return {
          id: r.id,
          event: r.event,
          requestId: r.request_id ?? null,
          createdAt: r.created_at,
          detail,
        };
      }),
    });
  } catch (err) {
    console.error("[irn][audit] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

export function isIrnStatus(value: unknown): value is (typeof IRN_STATUSES)[number] {
  return (IRN_STATUSES as readonly string[]).includes(String(value));
}

// ---------------------------------------------------------------------------
// POST /irn/seed — one-click demo invoices, posted to Tally with compliance
// ---------------------------------------------------------------------------

/**
 * Demo seed: two customers + two sales invoices that look exactly like
 * Phase 4-posted vouchers (status COMPLETED, Tally voucher number +
 * reference captured, line detail present) with the IRN compliance snapshot
 * already filled in — so "Request IRN" succeeds in one click. Idempotent:
 * existing invoice numbers are skipped, never duplicated.
 */
router.post("/irn/seed", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const now = new Date().toISOString();

    const customerNames = ["Sharma Traders", "Gupta Enterprises"];
    const customerIds: Record<string, string> = {};
    for (const name of customerNames) {
      const existing = await findCustomerByName(userId, name).catch(() => undefined);
      if (existing) {
        customerIds[name] = String(existing.id);
      } else {
        try {
          const created = await createCustomer(userId, name);
          customerIds[name] = String(created.id);
        } catch {
          const retry = await findCustomerByName(userId, name).catch(() => undefined);
          if (!retry) throw new Error(`Could not create demo customer "${name}"`);
          customerIds[name] = String(retry.id);
        }
      }
    }

    const demos = [
      {
        customerName: "Sharma Traders",
        invoice_number: "INV-DEMO-001",
        issue_date: "2026-10-13",
        due_date: "2026-11-13",
        amount: 11800,
        quantity: 10,
        unit: "Nos",
        unit_price: 1000,
        gst_rate: 18,
        sku_code: "Demo Widget",
        grand_total: 11800,
        tally_voucher_number: "27",
        tally_reference: "INV-DEMO-001",
        buyer_gstin: "29AADCB1234A1Z5",
      },
      {
        customerName: "Gupta Enterprises",
        invoice_number: "INV-DEMO-002",
        issue_date: "2026-10-14",
        due_date: "2026-11-14",
        amount: 11800,
        quantity: 5,
        unit: "Nos",
        unit_price: 2000,
        gst_rate: 18,
        sku_code: "Demo Widget Pro",
        grand_total: 11800,
        tally_voucher_number: "28",
        tally_reference: "INV-DEMO-002",
        buyer_gstin: "27AAHCG1234B1Z5",
      },
    ];

    let created = 0;
    let skipped = 0;
    const invoices: Array<Record<string, unknown>> = [];
    for (const d of demos) {
      const customerId = customerIds[d.customerName];
      const dupe = await findInvoiceByNumber(userId, customerId, d.invoice_number).catch(() => undefined);
      if (dupe) {
        skipped++;
        invoices.push(dupe as Record<string, unknown>);
        continue;
      }
      const row = await createInvoice(userId, {
        customer_id: customerId,
        invoice_number: d.invoice_number,
        issue_date: d.issue_date,
        due_date: d.due_date,
        amount: d.amount,
        balance: d.amount,
        status: "COMPLETED",
        quantity: d.quantity,
        unit: d.unit,
        unit_price: d.unit_price,
        gst_rate: d.gst_rate,
        sku_code: d.sku_code,
        grand_total: d.grand_total,
        version: 1,
        // Phase 4 Tally posting refs (as the connector ack would store them).
        tally_voucher_number: d.tally_voucher_number,
        tally_reference: d.tally_reference,
        tally_company_name: "Demo Company",
        sync_status: "COMPLETED",
        synced_at: now,
        // IRN compliance snapshot — one-click Request IRN needs nothing more.
        seller_gstin: "27AAPCS1234F1Z5",
        buyer_gstin: d.buyer_gstin,
        billing_address: "101 MG Road, Bengaluru, Karnataka 560001",
        shipping_address: "101 MG Road, Bengaluru, Karnataka 560001",
        place_of_supply: "29-Karnataka",
        hsn: "8471",
        irnStatus: "IRN_PENDING",
      });
      created++;
      invoices.push(row as Record<string, unknown>);
    }

    res.status(201).json({
      created,
      skipped,
      invoices: invoices.map((r) => ({
        id: r.id,
        invoice_number: r.invoice_number,
        tally_voucher_number: r.tally_voucher_number,
        tally_reference: r.tally_reference,
        irnStatus: r.irnStatus ?? "IRN_PENDING",
      })),
    });
  } catch (err) {
    console.error("[irn][seed] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

export default router;
