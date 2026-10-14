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
  EWB_STATUSES,
  MockEWayBillAdapter,
  ProductionEWayBillAdapter,
  ewbIdempotencyKey,
  ewbStatusForResponse,
  formatPreflightError,
  preflightEwb,
  TRANSPORT_MODES,
  type EwbRequest,
  type EWayBillAdapter,
  type MockEwbMode,
} from "../services/ewaybill.service.js";
import { buildInvoiceEwayPdf, type InvoiceEwbPdfData } from "../services/invoicePdf.service.js";

const router = Router();

/**
 * Phase 6: E-way bill generation after Tally voucher + IRN (mock adapter —
 * test results only).
 *
 *   POST /ewaybill/request        — dispatch capture + preflight + submit + store (JWT auth)
 *   POST /ewaybill/retry          — resubmit a FAILED / RETRYABLE / SUBMITTED EWB
 *   GET  /ewaybill/status/:id     — linked WhizUnik ↔ Tally ↔ IRN ↔ EWB view
 *   GET  /ewaybill/audit          — EWB audit history (?invoiceId=, ?limit=)
 *   POST /ewaybill/seed           — one-click IRN-verified demo invoices
 *   GET  /ewaybill/invoice-pdf/:id — TAX INVOICE + e-Way Bill PDF (MOCK-labelled)
 *
 * TEST-EWB-001 responses are mock results, never legally valid e-way bills.
 * Every response carries `environment: "MOCK"` + `legallyValid: false` while
 * the mock adapter is active.
 */

const dispatchSchema = z.object({
  dispatchWarehouse: z.string().trim().max(200).optional(),
  originAddress: z.string().trim().max(500).optional(),
  originPin: z.string().trim().max(10).optional(),
  destinationAddress: z.string().trim().max(500).optional(),
  destinationPin: z.string().trim().max(10).optional(),
  placeOfSupply: z.string().trim().max(100).optional(),
  transporterName: z.string().trim().max(200).optional(),
  transporterId: z.string().trim().max(50).optional(),
  transportMode: z.string().trim().max(20).optional(),
  vehicleNumber: z.string().trim().max(30).optional(),
  transportDocNumber: z.string().trim().max(100).optional(),
  transportDocDate: z.string().trim().max(30).optional(),
  distanceKm: z.number().finite().nonnegative().max(100_000).optional(),
  packageCount: z.number().finite().positive().max(1_000_000).optional(),
  packageType: z.string().trim().max(100).optional(),
  taxableValue: z.number().finite().nonnegative().max(1_000_000_000).optional(),
  gstAmount: z.number().finite().nonnegative().max(1_000_000_000).optional(),
  invoiceTotal: z.number().finite().positive().max(1_000_000_000).optional(),
  expectedDispatchDate: z.string().trim().max(30).optional(),
  sellerGstin: z.string().trim().max(15).optional(),
  buyerGstin: z.string().trim().max(15).optional().nullable(),
});

const requestSchema = z.object({
  invoiceId: z.string().trim().min(1).max(128),
  dispatch: dispatchSchema.optional().default({}),
  mockMode: z.enum(["SUCCESS", "INVALID_VEHICLE", "INVALID_PIN", "IRN_INVALID", "RETRYABLE_ERROR", "DUPLICATE"]).optional(),
  // Target flow: "queue" writes a REQUEST_EWAYBILL command for the connector
  // (verify voucher+IRN → build request → submit → ack back). "direct" runs
  // the same pipeline inline in the cloud (demo/testing without a connector).
  mode: z.enum(["direct", "queue"]).optional().default("direct"),
  connectorId: z.string().trim().min(1).max(120).optional(),
  companyId: z.string().trim().min(1).max(128).optional(),
});

const retrySchema = z.object({
  invoiceId: z.string().trim().min(1).max(128),
  mockMode: z.enum(["SUCCESS", "INVALID_VEHICLE", "INVALID_PIN", "IRN_INVALID", "RETRYABLE_ERROR", "DUPLICATE"]).optional(),
});

type Dispatch = z.infer<typeof dispatchSchema>;

function selectAdapter(mockMode?: MockEwbMode): EWayBillAdapter {
  if ((process.env.EWB_ADAPTER ?? "mock").toLowerCase() === "production") {
    return new ProductionEWayBillAdapter();
  }
  return new MockEWayBillAdapter(mockMode ?? "AUTO");
}

interface LinkedEwbView {
  whizunikInvoiceId: string;
  whizunikInvoiceNumber: string;
  tallyVoucherNumber: string | null;
  tallyReference: string | null;
  irn: string | null;
  ewayBillNumber: string | null;
  generatedDate: string | null;
  validUntil: string | null;
  vehicleNumber: string | null;
  transportDocumentNumber: string | null;
  ewayBillStatus: string;
  ewayBillRequestId: string | null;
  ewayBillGeneratedAt: string | null;
  dispatchStatus: string;
  inventoryStatus: string;
  duplicate: boolean;
  environment: string;
  legallyValid: boolean;
}

function toLinkedView(inv: Record<string, unknown>, duplicate: boolean, testMode: boolean): LinkedEwbView {
  const env = testMode ? "MOCK" : "PRODUCTION";
  return {
    whizunikInvoiceId: String(inv.id ?? ""),
    whizunikInvoiceNumber: String(inv.invoice_number ?? ""),
    tallyVoucherNumber: (inv.tally_voucher_number as string) ?? null,
    tallyReference: (inv.tally_reference as string) ?? null,
    irn: (inv.irn as string) ?? null,
    ewayBillNumber: (inv.ewayBillNumber as string) ?? null,
    generatedDate: (inv.ewayBillGeneratedDate as string) ?? null,
    validUntil: (inv.ewayBillValidUntil as string) ?? null,
    vehicleNumber: (inv.ewayBillVehicleNumber as string) ?? null,
    transportDocumentNumber: (inv.transport_doc_number as string) ?? null,
    ewayBillStatus: String(inv.ewayBillStatus ?? "EWB_PENDING"),
    ewayBillRequestId: (inv.ewayBillRequestId as string) ?? null,
    ewayBillGeneratedAt: (inv.ewayBillGeneratedAt as string) ?? null,
    dispatchStatus: String(inv.dispatchStatus ?? "DISPATCH_PENDING"),
    inventoryStatus: String(inv.inventoryStatus ?? "INVENTORY_NOT_DEDUCTED"),
    duplicate,
    environment: env,
    legallyValid: false,
  };
}

/**
 * Audit helper (§12). Every EWB log carries the invoice ID + number, Tally
 * voucher number + reference, IRN, e-way bill number (when known), request
 * ID, status and timestamp (created_at). Secrets are never logged.
 */
function ewbAudit(
  event: AuditEvent,
  ctx: {
    userId: string;
    invoiceId: string;
    invoiceNumber: string;
    tallyVoucherNumber: string | null;
    tallyReference: string | null;
    irn: string | null;
    requestId: string;
    ewayBillStatus: string;
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
      irn: ctx.irn,
      ewayBillStatus: ctx.ewayBillStatus,
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
  originAddress: string | null;
  originPin: string | null;
  destinationAddress: string | null;
  destinationPin: string | null;
  placeOfSupply: string | null;
  dispatchWarehouse: string | null;
  transporterName: string | null;
  transporterId: string | null;
  transportMode: string | null;
  vehicleNumber: string | null;
  transportDocNumber: string | null;
  transportDocDate: string | null;
  distanceKm: number | null;
  packageCount: number | null;
  packageType: string | null;
  expectedDispatchDate: string | null;
  skuCode: string | null;
  description: string | null;
  hsn: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  taxableValue: number | null;
  gstRate: number | null;
  gstAmount: number | null;
  invoiceTotal: number | null;
}

/**
 * Assemble the EWB dataset from the verified invoice: invoice (posted to
 * Tally, IRN_GENERATED) + customer + product, with explicit dispatch
 * overrides merged in. Overrides are persisted so "complete the details and
 * retry" works across calls.
 */
async function assembleData(
  userId: string,
  inv: Record<string, unknown>,
  dispatch: Dispatch
): Promise<{ data: AssembledData; persisted: Record<string, unknown> }> {
  const d = dispatch ?? {};
  const persisted: Record<string, unknown> = {};

  const persistMap: Record<string, string> = {
    dispatchWarehouse: "dispatch_warehouse",
    originAddress: "origin_address",
    originPin: "origin_pin",
    destinationAddress: "destination_address",
    destinationPin: "destination_pin",
    placeOfSupply: "place_of_supply",
    transporterName: "transporter_name",
    transporterId: "transporter_id",
    transportMode: "transport_mode",
    vehicleNumber: "vehicle_number",
    transportDocNumber: "transport_doc_number",
    transportDocDate: "transport_doc_date",
    distanceKm: "distance_km",
    packageCount: "package_count",
    packageType: "package_type",
    expectedDispatchDate: "expected_dispatch_date",
    taxableValue: "taxable_value",
    gstAmount: "gst_amount",
    invoiceTotal: "grand_total",
    sellerGstin: "seller_gstin",
    buyerGstin: "buyer_gstin",
  };
  for (const [from, to] of Object.entries(persistMap)) {
    const v = (d as Record<string, unknown>)[from];
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

  // --- Preconditions: verified Tally voucher + verified IRN required ---
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
  const irn = str(merged.irn);
  const irnStatus = str(merged.irnStatus) ?? "IRN_PENDING";
  if (!irn || irnStatus !== "IRN_GENERATED") {
    return {
      data: { ineligible: { missingField: "IRN", action: "Generate the IRN first (IRN status must be IRN_GENERATED) and retry." } } as AssembledData,
      persisted: {},
    };
  }

  // --- Field assembly (verified data first, overrides fill gaps) ---
  const quantity = numOrNull(merged.quantity ?? merged.qty);
  const unitPrice = numOrNull(merged.unit_price ?? merged.unitPrice);
  const gstRate = numOrNull(merged.gst_rate ?? merged.gstRate);
  let taxableValue = numOrNull(merged.taxable_value ?? merged.taxableValue);
  if (taxableValue === null && quantity !== null && unitPrice !== null) {
    taxableValue = round2(quantity * unitPrice);
    persisted.taxable_value = taxableValue;
  }
  let gstAmount = numOrNull(merged.gst_amount ?? merged.gstAmount);
  if (gstAmount === null) {
    const cgst = numOrNull(merged.cgst);
    const sgst = numOrNull(merged.sgst);
    const igst = numOrNull(merged.igst);
    if (cgst !== null || sgst !== null || igst !== null) {
      gstAmount = round2((cgst ?? 0) + (sgst ?? 0) + (igst ?? 0));
      persisted.gst_amount = gstAmount;
    } else if (taxableValue !== null && gstRate !== null) {
      gstAmount = round2((taxableValue * gstRate) / 100);
      persisted.gst_amount = gstAmount;
    }
  }
  const invoiceTotal = numOrNull(merged.grand_total ?? merged.grandTotal ?? merged.amount);

  if (Object.keys(persisted).length > 0) {
    await updateInvoice(userId, String(inv.id), persisted);
    merged = { ...merged, ...persisted };
  }

  return {
    data: {
      sellerGstin: str(merged.seller_gstin ?? merged.sellerGstin),
      buyerGstin: str(merged.buyer_gstin ?? merged.buyerGstin ?? customer?.gstin),
      buyerName: str(customer?.name),
      originAddress: str(merged.origin_address ?? merged.originAddress ?? merged.billing_address),
      originPin: str(merged.origin_pin ?? merged.originPin),
      destinationAddress: str(merged.destination_address ?? merged.destinationAddress ?? merged.shipping_address ?? customer?.address),
      destinationPin: str(merged.destination_pin ?? merged.destinationPin ?? customer?.pin),
      placeOfSupply: str(merged.place_of_supply ?? merged.placeOfSupply),
      dispatchWarehouse: str(merged.dispatch_warehouse ?? merged.dispatchWarehouse),
      transporterName: str(merged.transporter_name ?? merged.transporterName),
      transporterId: str(merged.transporter_id ?? merged.transporterId),
      transportMode: str(merged.transport_mode ?? merged.transportMode),
      vehicleNumber: str(merged.vehicle_number ?? merged.vehicleNumber),
      transportDocNumber: str(merged.transport_doc_number ?? merged.transportDocNumber),
      transportDocDate: str(merged.transport_doc_date ?? merged.transportDocDate),
      distanceKm: numOrNull(merged.distance_km ?? merged.distanceKm),
      packageCount: numOrNull(merged.package_count ?? merged.packageCount),
      packageType: str(merged.package_type ?? merged.packageType),
      expectedDispatchDate: str(merged.expected_dispatch_date ?? merged.expectedDispatchDate),
      skuCode: str(merged.sku_code ?? merged.skuCode ?? product?.sku_code ?? product?.name),
      description: str(merged.line_description ?? merged.description ?? product?.description),
      hsn: str(merged.hsn ?? product?.hsn),
      quantity,
      unit: str(merged.unit ?? merged.base_unit ?? product?.base_unit),
      unitPrice,
      taxableValue,
      gstRate,
      gstAmount,
      invoiceTotal,
    },
    persisted,
  };
}

function toPreflightInput(
  data: AssembledData,
  inv: Record<string, unknown>
): Parameters<typeof preflightEwb>[0] {
  return {
    irn: str(inv.irn),
    irnStatus: str(inv.irnStatus) ?? "IRN_PENDING",
    voucherExistsInTally: true, // gated by COMPLETED + captured refs above
    invoiceNumber: String(inv.invoice_number ?? ""),
    tallyReference: str(inv.tally_reference),
    sellerGstin: data.sellerGstin,
    buyerGstin: data.buyerGstin,
    buyerName: data.buyerName,
    originAddress: data.originAddress,
    originPin: data.originPin,
    destinationAddress: data.destinationAddress,
    destinationPin: data.destinationPin,
    transportMode: data.transportMode,
    transporterName: data.transporterName,
    vehicleNumber: data.vehicleNumber,
    transportDocNumber: data.transportDocNumber,
    dispatchWarehouse: data.dispatchWarehouse,
    taxableValue: data.taxableValue,
    gstAmount: data.gstAmount,
    invoiceTotal: data.invoiceTotal,
    alreadyHasEwb: !!str(inv.ewayBillNumber),
  };
}

function buildEwbRequest(
  data: AssembledData,
  inv: Record<string, unknown>,
  requestId: string,
  testMode: boolean
): EwbRequest {
  const invoiceDate = String(inv.issue_date ?? "").slice(0, 10);
  const sellerGstin = String(data.sellerGstin ?? "").trim().toUpperCase();
  const invoiceNumber = String(inv.invoice_number ?? "").trim();
  return {
    whizunikInvoiceId: String(inv.id ?? ""),
    whizunikInvoiceNumber: invoiceNumber,
    tallyVoucherNumber: String(inv.tally_voucher_number ?? ""),
    tallyReference: String(inv.tally_reference ?? ""),
    invoiceDate,
    invoiceValue: data.invoiceTotal,
    irn: String(inv.irn ?? ""),
    sellerGstin,
    buyerGstin: data.buyerGstin ? String(data.buyerGstin).trim().toUpperCase() : null,
    buyerName: String(data.buyerName ?? ""),
    originAddress: data.originAddress,
    originPin: data.originPin,
    destinationAddress: data.destinationAddress,
    destinationPin: data.destinationPin,
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
        gstAmount: data.gstAmount,
      },
    ],
    quantity: data.quantity,
    taxableValue: data.taxableValue,
    gstAmount: data.gstAmount,
    transportMode: String(data.transportMode ?? ""),
    transporterName: data.transporterName,
    transporterId: data.transporterId,
    vehicleNumber: data.vehicleNumber,
    transportDocNumber: data.transportDocNumber,
    transportDocDate: data.transportDocDate,
    distanceKm: data.distanceKm,
    idempotencyKey: ewbIdempotencyKey(sellerGstin, invoiceNumber, invoiceDate),
    requestId,
    testMode,
  };
}

/** Duplicate protection (§10): existing EWB on this invoice or the same idempotency key. */
async function findDuplicateEwb(
  userId: string,
  invoiceId: string,
  idempotencyKey: string
): Promise<Record<string, unknown> | null> {
  const rows = await listInvoices(userId);
  // 1. This invoice already carries an e-way bill.
  const self = rows.find((r) => String(r.id) === invoiceId && str(r.ewayBillNumber));
  if (self) return self as Record<string, unknown>;
  // 2. Same seller + number + date already produced an e-way bill.
  const other = rows.find(
    (r) => String(r.id) !== invoiceId && String(r.ewb_idempotency_key ?? "") === idempotencyKey && str(r.ewayBillNumber)
  );
  if (other) return other as Record<string, unknown>;
  return null;
}

/** Store a successful result: EWB fields + dispatch release + inventory deduction (§9). */
async function storeGeneratedEwb(
  userId: string,
  invoiceId: string,
  opts: {
    ewayBillNumber: string;
    generatedDate: string;
    validUntil: string;
    vehicleNumber: string;
    transportDocNumber: string | null;
    requestId: string;
    idempotencyKey: string;
    environment: string;
  }
): Promise<void> {
  const inv = (await getInvoice(userId, invoiceId)) as Record<string, unknown> | undefined;
  const qty = inv ? Number(inv.quantity ?? 0) : 0;
  await updateInvoice(userId, invoiceId, {
    ewayBillStatus: "EWB_GENERATED",
    ewayBillNumber: opts.ewayBillNumber,
    ewayBillGeneratedDate: opts.generatedDate,
    ewayBillValidUntil: opts.validUntil,
    ewayBillVehicleNumber: opts.vehicleNumber,
    ewayBillRequestId: opts.requestId,
    ewayBillGeneratedAt: new Date().toISOString(),
    ewb_idempotency_key: opts.idempotencyKey,
    ewayBillEnvironment: opts.environment,
    ewayBillLegallyValid: false,
    ewayBillErrorCode: null,
    ewayBillErrorMessage: null,
    dispatchStatus: "DISPATCH_RELEASED",
    dispatchedAt: new Date().toISOString(),
    inventoryStatus: "INVENTORY_DEDUCTED",
    inventoryDeductedAt: new Date().toISOString(),
    inventoryDeductedQty: Number.isFinite(qty) ? qty : null,
  });
}

/** Store a terminal failure: dispatch stays blocked, inventory untouched (§9). */
async function storeFailedEwb(
  userId: string,
  invoiceId: string,
  opts: { status: "EWB_FAILED" | "EWB_RETRYABLE"; errorCode: string | null; errorMessage: string | null; requestId: string; idempotencyKey: string }
): Promise<void> {
  await updateInvoice(userId, invoiceId, {
    ewayBillStatus: opts.status,
    ewayBillRequestId: opts.requestId,
    ewb_idempotency_key: opts.idempotencyKey,
    ewayBillErrorCode: opts.errorCode,
    ewayBillErrorMessage: opts.errorMessage,
    dispatchStatus: "DISPATCH_BLOCKED",
    inventoryStatus: "INVENTORY_NOT_DEDUCTED",
  });
}

// ---------------------------------------------------------------------------
// Target flow: queue a REQUEST_EWAYBILL command for the connector
// ---------------------------------------------------------------------------

interface QueueEwbContext {
  userId: string;
  invoiceId: string;
  invoiceNumber: string;
  tallyVoucherNumber: string | null;
  tallyReference: string | null;
  irn: string | null;
  connectorId?: string;
  companyId?: string;
  mockMode?: "SUCCESS" | "INVALID_VEHICLE" | "INVALID_PIN" | "IRN_INVALID" | "RETRYABLE_ERROR" | "DUPLICATE";
  testMode: boolean;
  data: AssembledData;
  inv: Record<string, unknown>;
  ewbRequest: EwbRequest;
  requestId: string;
}

/**
 * Queue mode: the cloud never touches the portal. The verified dispatch
 * dataset travels to the paired connector as a REQUEST_EWAYBILL command; the
 * connector verifies the Tally voucher + IRN, rebuilds the request, submits
 * via its own adapter and acks the result back (applied by applyEwbAck).
 */
async function queueEwbCommand(res: Response, ctx: QueueEwbContext): Promise<void> {
  const { userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn } = ctx;
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
    ewb: {
      invoiceId: ctx.invoiceId,
      invoiceNumber: String(ctx.inv.invoice_number ?? ""),
      invoiceDate: String(ctx.inv.issue_date ?? "").slice(0, 10),
      tallyVoucherNumber: String(ctx.inv.tally_voucher_number ?? ""),
      tallyReference: String(ctx.inv.tally_reference ?? ""),
      irn: String(ctx.inv.irn ?? ""),
      buyerName: d.buyerName,
      sellerGstin: d.sellerGstin,
      buyerGstin: d.buyerGstin,
      originAddress: d.originAddress,
      originPin: d.originPin,
      destinationAddress: d.destinationAddress,
      destinationPin: d.destinationPin,
      placeOfSupply: d.placeOfSupply,
      dispatchWarehouse: d.dispatchWarehouse,
      transporterName: d.transporterName,
      transporterId: d.transporterId,
      transportMode: d.transportMode,
      vehicleNumber: d.vehicleNumber,
      transportDocNumber: d.transportDocNumber,
      transportDocDate: d.transportDocDate,
      distanceKm: d.distanceKm,
      packageCount: d.packageCount,
      packageType: d.packageType,
      expectedDispatchDate: d.expectedDispatchDate,
      skuCode: d.skuCode,
      description: d.description,
      hsn: d.hsn,
      quantity: d.quantity,
      unit: d.unit,
      unitPrice: d.unitPrice,
      taxableValue: d.taxableValue,
      gstRate: d.gstRate,
      gstAmount: d.gstAmount,
      invoiceTotal: d.invoiceTotal,
      idempotencyKey: ctx.ewbRequest.idempotencyKey,
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
      command: "REQUEST_EWAYBILL",
      payload: JSON.stringify(payload),
    });
  } else {
    await createSyncCommand({
      id,
      user_id: userId,
      connector_id: target.rowId,
      command: "REQUEST_EWAYBILL",
      payload: JSON.stringify(payload),
    });
  }

  await updateInvoice(userId, invoiceId, {
    ewayBillStatus: "EWB_SUBMITTED",
    ewayBillRequestId: ctx.requestId,
    ewb_idempotency_key: ctx.ewbRequest.idempotencyKey,
    dispatchStatus: "DISPATCH_PENDING",
    connector_id: target.connectorId,
    push_command_id: id,
  });
  ewbAudit("EWB_REQUEST_CREATED", {
    userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
    requestId: ctx.requestId,
    ewayBillStatus: "EWB_REQUEST_READY",
    extra: { idempotencyKey: ctx.ewbRequest.idempotencyKey },
  });
  ewbAudit("EWB_SUBMITTED", {
    userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
    requestId: ctx.requestId,
    ewayBillStatus: "EWB_SUBMITTED",
    extra: { commandId: id, connectorId: target.connectorId },
  });

  const fresh = ((await getInvoice(userId, invoiceId)) ?? ctx.inv) as Record<string, unknown>;
  res.status(202).json({
    ...toLinkedView(fresh, false, ctx.testMode),
    commandId: id,
    message: "E-way bill request queued for the connector. The e-way bill lands on the invoice when the connector acks the result.",
  });
}

// ---------------------------------------------------------------------------
// POST /ewaybill/request
// ---------------------------------------------------------------------------

router.post("/ewaybill/request", requireAuth, async (req: Request, res: Response) => {
  const parsed = requestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
    return;
  }
  try {
    const userId = req.user!.userId;
    const { invoiceId, dispatch, mockMode, mode, connectorId, companyId } = parsed.data;

    const inv = (await getInvoice(userId, invoiceId)) as Record<string, unknown> | undefined;
    if (!inv) {
      sendWzError(res, "INVALID_PAYLOAD", "Invoice not found for this account");
      return;
    }
    const invoiceNumber = String(inv.invoice_number ?? "");
    const tallyVoucherNumber = str(inv.tally_voucher_number);
    const tallyReference = str(inv.tally_reference);
    const irn = str(inv.irn);
    const requestId = `ewb_${uuidv4().replace(/-/g, "").slice(0, 16)}`;

    ewbAudit("EWB_PREFLIGHT_STARTED", {
      userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
      requestId,
      ewayBillStatus: String(inv.ewayBillStatus ?? "EWB_PENDING"),
    });

    // Duplicate protection first (§10.1): an invoice that already has an
    // e-way bill never submits a second request — return the existing one.
    if (str(inv.ewayBillNumber)) {
      const existingAdapter = selectAdapter(mockMode);
      res.status(200).json({
        ...toLinkedView(inv, true, existingAdapter.testMode),
        message: "E-way bill already exists. Returning the existing e-way bill — no second request submitted.",
      });
      return;
    }

    const { data } = await assembleData(userId, inv, dispatch ?? {});
    if (data.ineligible) {
      ewbAudit("EWB_PREFLIGHT_FAILED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: String(inv.ewayBillStatus ?? "EWB_PENDING"),
        extra: { missingField: data.ineligible.missingField },
      });
      res.status(422).json({
        error: "E-way bill cannot be requested.",
        missingField: data.ineligible.missingField,
        action: data.ineligible.action,
        failures: [{ missingField: data.ineligible.missingField, action: data.ineligible.action }],
      });
      return;
    }

    const preflight = preflightEwb(toPreflightInput(data, inv));
    if (!preflight.ok) {
      ewbAudit("EWB_PREFLIGHT_FAILED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: String(inv.ewayBillStatus ?? "EWB_PENDING"),
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

    ewbAudit("EWB_PREFLIGHT_PASSED", {
      userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
      requestId,
      ewayBillStatus: "EWB_REQUEST_READY",
    });
    await updateInvoice(userId, invoiceId, { ewayBillStatus: "EWB_REQUEST_READY" });

    const adapter = selectAdapter(mockMode);
    const ewbRequest = buildEwbRequest(data, inv, requestId, adapter.testMode);

    // Duplicate protection before submission (§10).
    const dup = await findDuplicateEwb(userId, invoiceId, ewbRequest.idempotencyKey);
    if (dup) {
      const view = toLinkedView(dup.id === invoiceId ? { ...inv, ...dup } : dup, true, adapter.testMode);
      res.status(200).json({ ...view, message: "E-way bill already exists. Returning the existing e-way bill — no second request submitted." });
      return;
    }

    // Target flow (queue mode): hand the verified request to the connector
    // as a REQUEST_EWAYBILL command. The e-way bill lands via applyEwbAck.
    if (mode === "queue") {
      await queueEwbCommand(res, {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        connectorId, companyId, mockMode, testMode: adapter.testMode,
        data, inv, ewbRequest, requestId,
      });
      return;
    }

    ewbAudit("EWB_REQUEST_CREATED", {
      userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
      requestId,
      ewayBillStatus: "EWB_REQUEST_READY",
      extra: { idempotencyKey: ewbRequest.idempotencyKey },
    });
    await updateInvoice(userId, invoiceId, {
      ewayBillStatus: "EWB_SUBMITTED",
      ewayBillRequestId: requestId,
      ewb_idempotency_key: ewbRequest.idempotencyKey,
      dispatchStatus: "DISPATCH_PENDING",
    });
    ewbAudit("EWB_SUBMITTED", {
      userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
      requestId,
      ewayBillStatus: "EWB_SUBMITTED",
      extra: { adapter: adapter.name },
    });

    let adapterResponse;
    try {
      adapterResponse = await adapter.submit(ewbRequest);
    } catch (err) {
      // Production adapter not configured (government access unavailable).
      await storeFailedEwb(userId, invoiceId, {
        status: "EWB_RETRYABLE",
        errorCode: "ADAPTER_NOT_CONFIGURED",
        errorMessage: err instanceof Error ? err.message : String(err),
        requestId,
        idempotencyKey: ewbRequest.idempotencyKey,
      });
      ewbAudit("EWB_RETRYABLE_FAILURE", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: "EWB_RETRYABLE",
        extra: { errorCode: "ADAPTER_NOT_CONFIGURED" },
      });
      sendWzError(res, "SERVER_ERROR", err instanceof Error ? err.message : "E-way bill adapter unavailable");
      return;
    }

    ewbAudit("EWB_RESPONSE_RECEIVED", {
      userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
      requestId,
      ewayBillStatus: ewbStatusForResponse(adapterResponse),
      extra: {
        adapterStatus: adapterResponse.status,
        errorCode: adapterResponse.errorCode ?? null,
      },
    });

    const nextStatus = ewbStatusForResponse(adapterResponse);
    if (adapterResponse.status === "SUCCESS" || adapterResponse.status === "DUPLICATE") {
      await storeGeneratedEwb(userId, invoiceId, {
        ewayBillNumber: adapterResponse.ewayBillNumber!,
        generatedDate: adapterResponse.generatedDate ?? String(inv.issue_date ?? "").slice(0, 10),
        validUntil: adapterResponse.validUntil ?? String(inv.issue_date ?? "").slice(0, 10),
        vehicleNumber: adapterResponse.vehicleNumber ?? String(data.vehicleNumber ?? ""),
        transportDocNumber: data.transportDocNumber,
        requestId,
        idempotencyKey: ewbRequest.idempotencyKey,
        environment: adapter.testMode ? "MOCK" : "PRODUCTION",
      });
      ewbAudit("EWB_GENERATED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: "EWB_GENERATED",
        extra: { ewayBillNumber: adapterResponse.ewayBillNumber ?? null },
      });
      ewbAudit("EWB_RESULT_STORED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: "EWB_GENERATED",
      });
      ewbAudit("DISPATCH_RELEASED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: "EWB_GENERATED",
        extra: { ewayBillNumber: adapterResponse.ewayBillNumber ?? null },
      });
      ewbAudit("INVENTORY_DEDUCTED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: "EWB_GENERATED",
      });
      const fresh = ((await getInvoice(userId, invoiceId)) ?? inv) as Record<string, unknown>;
      res.status(adapterResponse.status === "DUPLICATE" ? 200 : 201).json({
        ...toLinkedView(fresh, adapterResponse.status === "DUPLICATE", adapter.testMode),
      });
      return;
    }

    if (adapterResponse.status === "REJECTED") {
      await storeFailedEwb(userId, invoiceId, {
        status: "EWB_FAILED",
        errorCode: adapterResponse.errorCode ?? null,
        errorMessage: adapterResponse.errorMessage ?? null,
        requestId,
        idempotencyKey: ewbRequest.idempotencyKey,
      });
      ewbAudit("EWB_REJECTED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: "EWB_FAILED",
        extra: {
          errorCode: adapterResponse.errorCode ?? null,
          errorMessage: adapterResponse.errorMessage ?? null,
        },
      });
      ewbAudit("EWB_RESULT_STORED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: "EWB_FAILED",
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

    // RETRYABLE_ERROR — stays retryable, dispatch blocked, inventory untouched.
    await storeFailedEwb(userId, invoiceId, {
      status: "EWB_RETRYABLE",
      errorCode: adapterResponse.errorCode ?? null,
      errorMessage: adapterResponse.errorMessage ?? null,
      requestId,
      idempotencyKey: ewbRequest.idempotencyKey,
    });
    ewbAudit("EWB_RETRYABLE_FAILURE", {
      userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
      requestId,
      ewayBillStatus: "EWB_RETRYABLE",
      extra: {
        errorCode: adapterResponse.errorCode ?? null,
        errorMessage: adapterResponse.errorMessage ?? null,
      },
    });
    ewbAudit("EWB_RESULT_STORED", {
      userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
      requestId,
      ewayBillStatus: "EWB_RETRYABLE",
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
    console.error("[ewb][request] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

// ---------------------------------------------------------------------------
// POST /ewaybill/retry — resubmit FAILED / RETRYABLE / SUBMITTED (restart-safe)
// ---------------------------------------------------------------------------

router.post("/ewaybill/retry", requireAuth, async (req: Request, res: Response) => {
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
    const current = String(inv.ewayBillStatus ?? "EWB_PENDING");
    // Only non-terminal states may be resubmitted. GENERATED / CANCELLED /
    // EXPIRED never resubmit (duplicate protection); PENDING / REQUEST_READY
    // must go through POST /ewaybill/request first.
    if (!["EWB_FAILED", "EWB_RETRYABLE", "EWB_SUBMITTED"].includes(current)) {
      sendWzError(
        res,
        "INVALID_PAYLOAD",
        `Invoice e-way bill status is ${current} — only EWB_FAILED, EWB_RETRYABLE or EWB_SUBMITTED can be retried`
      );
      return;
    }
    if (str(inv.ewayBillNumber)) {
      const adapter = selectAdapter(mockMode);
      res.status(200).json({
        ...toLinkedView(inv, true, adapter.testMode),
        message: "E-way bill already exists. Returning the existing e-way bill — no second request submitted.",
      });
      return;
    }

    const invoiceNumber = String(inv.invoice_number ?? "");
    const tallyVoucherNumber = str(inv.tally_voucher_number);
    const tallyReference = str(inv.tally_reference);
    const irn = str(inv.irn);
    const requestId = `ewb_${uuidv4().replace(/-/g, "").slice(0, 16)}`;

    ewbAudit("EWB_PREFLIGHT_STARTED", {
      userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
      requestId,
      ewayBillStatus: current,
    });

    const { data } = await assembleData(userId, inv, {});
    if (data.ineligible) {
      res.status(422).json({
        error: "E-way bill cannot be requested.",
        missingField: data.ineligible.missingField,
        action: data.ineligible.action,
      });
      return;
    }
    const preflight = preflightEwb(toPreflightInput(data, inv));
    if (!preflight.ok) {
      ewbAudit("EWB_PREFLIGHT_FAILED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: current,
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
    const ewbRequest = buildEwbRequest(data, inv, requestId, adapter.testMode);
    const dup = await findDuplicateEwb(userId, invoiceId, ewbRequest.idempotencyKey);
    if (dup) {
      res.status(200).json({
        ...toLinkedView(dup.id === invoiceId ? { ...inv, ...dup } : dup, true, adapter.testMode),
        message: "E-way bill already exists. Returning the existing e-way bill — no second request submitted.",
      });
      return;
    }

    await updateInvoice(userId, invoiceId, {
      ewayBillStatus: "EWB_SUBMITTED",
      ewayBillRequestId: requestId,
      ewb_idempotency_key: ewbRequest.idempotencyKey,
      dispatchStatus: "DISPATCH_PENDING",
    });
    ewbAudit("EWB_SUBMITTED", {
      userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
      requestId,
      ewayBillStatus: "EWB_SUBMITTED",
      extra: { adapter: adapter.name, retry: true },
    });

    const adapterResponse = await adapter.submit(ewbRequest);
    ewbAudit("EWB_RESPONSE_RECEIVED", {
      userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
      requestId,
      ewayBillStatus: ewbStatusForResponse(adapterResponse),
      extra: { adapterStatus: adapterResponse.status, errorCode: adapterResponse.errorCode ?? null },
    });

    const nextStatus = ewbStatusForResponse(adapterResponse);
    if (nextStatus === "EWB_GENERATED") {
      await storeGeneratedEwb(userId, invoiceId, {
        ewayBillNumber: adapterResponse.ewayBillNumber!,
        generatedDate: adapterResponse.generatedDate ?? String(inv.issue_date ?? "").slice(0, 10),
        validUntil: adapterResponse.validUntil ?? String(inv.issue_date ?? "").slice(0, 10),
        vehicleNumber: adapterResponse.vehicleNumber ?? String(data.vehicleNumber ?? ""),
        transportDocNumber: data.transportDocNumber,
        requestId,
        idempotencyKey: ewbRequest.idempotencyKey,
        environment: adapter.testMode ? "MOCK" : "PRODUCTION",
      });
      ewbAudit("EWB_GENERATED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: "EWB_GENERATED",
        extra: { ewayBillNumber: adapterResponse.ewayBillNumber ?? null },
      });
      ewbAudit("EWB_RESULT_STORED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: "EWB_GENERATED",
      });
      ewbAudit("DISPATCH_RELEASED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: "EWB_GENERATED",
        extra: { ewayBillNumber: adapterResponse.ewayBillNumber ?? null },
      });
      ewbAudit("INVENTORY_DEDUCTED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: "EWB_GENERATED",
      });
    } else {
      await storeFailedEwb(userId, invoiceId, {
        status: nextStatus as "EWB_FAILED" | "EWB_RETRYABLE",
        errorCode: adapterResponse.errorCode ?? null,
        errorMessage: adapterResponse.errorMessage ?? null,
        requestId,
        idempotencyKey: ewbRequest.idempotencyKey,
      });
      ewbAudit(nextStatus === "EWB_FAILED" ? "EWB_REJECTED" : "EWB_RETRYABLE_FAILURE", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: nextStatus,
        extra: { errorCode: adapterResponse.errorCode ?? null },
      });
      ewbAudit("EWB_RESULT_STORED", {
        userId, invoiceId, invoiceNumber, tallyVoucherNumber, tallyReference, irn,
        requestId,
        ewayBillStatus: nextStatus,
      });
    }
    const fresh = ((await getInvoice(userId, invoiceId)) ?? inv) as Record<string, unknown>;
    res.status(200).json({
      ...toLinkedView(fresh, false, adapter.testMode),
      errorCode: adapterResponse.errorCode ?? null,
      errorMessage: adapterResponse.errorMessage ?? null,
    });
  } catch (err) {
    console.error("[ewb][retry] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

// ---------------------------------------------------------------------------
// GET /ewaybill/status/:invoiceId — linked WhizUnik ↔ Tally ↔ IRN ↔ EWB view
// ---------------------------------------------------------------------------

router.get("/ewaybill/status/:invoiceId", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const invoiceId = String(req.params.invoiceId ?? "");
    const inv = (await getInvoice(userId, invoiceId)) as Record<string, unknown> | undefined;
    if (!inv) {
      sendWzError(res, "INVALID_PAYLOAD", "Invoice not found for this account");
      return;
    }
    const testMode = (process.env.EWB_ADAPTER ?? "mock").toLowerCase() !== "production";
    res.status(200).json({
      ...toLinkedView(inv, false, testMode),
      invoiceStatus: String(inv.status ?? ""),
      irnStatus: String(inv.irnStatus ?? "IRN_PENDING"),
      errorCode: (inv.ewayBillErrorCode as string) ?? null,
      errorMessage: (inv.ewayBillErrorMessage as string) ?? null,
    });
  } catch (err) {
    console.error("[ewb][status] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

// ---------------------------------------------------------------------------
// GET /ewaybill/audit — EWB audit history
// ---------------------------------------------------------------------------

const EWB_EVENTS = new Set<string>([
  "EWB_PREFLIGHT_STARTED",
  "EWB_PREFLIGHT_PASSED",
  "EWB_PREFLIGHT_FAILED",
  "EWB_REQUEST_CREATED",
  "EWB_SUBMITTED",
  "EWB_RESPONSE_RECEIVED",
  "EWB_GENERATED",
  "EWB_REJECTED",
  "EWB_RETRYABLE_FAILURE",
  "EWB_RESULT_STORED",
  "DISPATCH_RELEASED",
  "INVENTORY_DEDUCTED",
]);

router.get("/ewaybill/audit", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { invoiceId, limit } = req.query as Record<string, string | undefined>;
    const take = Math.min(Math.max(parseInt(limit || "50", 10) || 50, 1), 200);
    let rows = await listAuditForUser(userId, 500);
    rows = rows.filter((r) => EWB_EVENTS.has(String(r.event ?? "")));
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
    console.error("[ewb][audit] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

// ---------------------------------------------------------------------------
// GET /ewaybill/invoice-pdf/:invoiceId — TAX INVOICE + e-Way Bill PDF
// ---------------------------------------------------------------------------

const STATE_BY_CODE: Record<string, string> = {
  "27": "Maharashtra",
  "29": "Karnataka",
  "07": "Delhi",
  "09": "Uttar Pradesh",
  "19": "West Bengal",
  "33": "Tamil Nadu",
  "36": "Telangana",
};

function stateOf(gstin: string | null, fallback: string): string {
  const code = String(gstin ?? "").slice(0, 2);
  if (STATE_BY_CODE[code]) return `${code}-${STATE_BY_CODE[code]}`;
  const m = String(fallback ?? "").match(/(\d{2})-([A-Za-z ]+)/);
  if (m) return `${m[1]}-${m[2].trim()}`;
  return fallback || "-";
}

router.get("/ewaybill/invoice-pdf/:invoiceId", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const invoiceId = String(req.params.invoiceId ?? "");
    const inv = (await getInvoice(userId, invoiceId)) as Record<string, unknown> | undefined;
    if (!inv) {
      sendWzError(res, "INVALID_PAYLOAD", "Invoice not found for this account");
      return;
    }
    if (String(inv.ewayBillStatus ?? "EWB_PENDING") !== "EWB_GENERATED" || !str(inv.ewayBillNumber)) {
      sendWzError(res, "INVALID_PAYLOAD", "E-way bill is not generated for this invoice — the invoice PDF with e-way bill is available only after EWB_GENERATED");
      return;
    }

    const customerId = String(inv.customer_id ?? "");
    const customer = customerId ? await getCustomer(userId, customerId).catch(() => undefined) : undefined;
    const skuId = (inv.sku_id as string) ?? null;
    const product = skuId ? await getProduct(userId, String(skuId)).catch(() => undefined) : undefined;

    const qty = numOrNull(inv.quantity) ?? 0;
    const unit = str(inv.unit ?? product?.base_unit) ?? "Nos";
    const unitPrice = numOrNull(inv.unit_price) ?? 0;
    const gstRate = numOrNull(inv.gst_rate) ?? 0;
    const taxable = numOrNull(inv.taxable_value) ?? round2(qty * unitPrice);
    const cgst = numOrNull(inv.cgst);
    const sgst = numOrNull(inv.sgst);
    const igst = numOrNull(inv.igst);
    const storedGst = numOrNull(inv.gst_amount);
    const gst =
      storedGst ??
      (cgst !== null || sgst !== null || igst !== null
        ? round2((cgst ?? 0) + (sgst ?? 0) + (igst ?? 0))
        : round2((taxable * gstRate) / 100));
    const total = numOrNull(inv.grand_total ?? inv.amount) ?? round2(taxable + gst);

    const sellerGstin = str(inv.seller_gstin) ?? "";
    const buyerGstin = str(inv.buyer_gstin ?? customer?.gstin) ?? "";
    const buyerAddr =
      str(inv.destination_address ?? inv.shipping_address ?? customer?.address) ??
      "Mumbai, Maharashtra, 400072";
    const data: InvoiceEwbPdfData = {
      sellerName: str(inv.tally_company_name) ?? "Seller",
      sellerGstin,
      sellerState: stateOf(sellerGstin, str(inv.place_of_supply) ?? ""),
      sellerEmail: str(inv.seller_email) ?? "",
      buyerName: str(customer?.name) ?? "Buyer",
      buyerAddress: buyerAddr,
      buyerGstin,
      buyerState: stateOf(buyerGstin, str(inv.place_of_supply) ?? ""),
      invoiceNumber: String(inv.invoice_number ?? ""),
      invoiceDate: String(inv.issue_date ?? "").slice(0, 10),
      ewayBillNumber: str(inv.ewayBillNumber),
      irn: str(inv.irn),
      ackNumber: (inv.acknowledgementNumber as string) ?? null,
      ackDate: (inv.acknowledgementDate as string) ?? String(inv.issue_date ?? "").slice(0, 10),
      deliveryNote: str(inv.delivery_note) ?? "",
      paymentTerms: str(inv.payment_terms) ?? "Net 30",
      dispatchedThrough: str(inv.transporter_name) ?? "",
      destination: str(inv.destination_address ?? inv.shipping_address) ?? "",
      items: [
        {
          description: str(inv.line_description ?? product?.description ?? product?.name ?? inv.sku_code) ?? "Goods",
          hsn: str(inv.hsn ?? product?.hsn) ?? "",
          quantity: qty,
          unit,
          rateInclTax: round2(unitPrice * (1 + gstRate / 100)),
          rate: unitPrice,
          amount: taxable,
        },
      ],
      taxableValue: taxable,
      gstRate,
      gstAmount: gst,
      invoiceTotal: total,
      transportMode: str(inv.transport_mode) ?? "Road",
      transporterId: str(inv.transporter_id),
      transporterName: str(inv.transporter_name),
      transportDocNumber: str(inv.transport_doc_number),
      transportDocDate: str(inv.transport_doc_date),
      vehicleNumber: str(inv.ewayBillVehicleNumber ?? inv.vehicle_number),
      distanceKm: numOrNull(inv.distance_km),
      generatedDate: (inv.ewayBillGeneratedDate as string) ?? null,
      validUntil: (inv.ewayBillValidUntil as string) ?? null,
      supplyType: str(inv.supply_type) ?? (buyerGstin ? "Outward-Supply" : "Outward-Supply"),
      transactionType: "Bill From - Dispatch From",
      environment: (inv.ewayBillEnvironment as string) ?? "MOCK",
      legallyValid: false,
    };

    const pdf = buildInvoiceEwayPdf(data);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="invoice-${String(inv.invoice_number ?? invoiceId).replace(/[^A-Za-z0-9_-]+/g, "_")}-ewaybill.pdf"`
    );
    res.setHeader("Content-Length", String(pdf.length));
    res.status(200).send(pdf);
  } catch (err) {
    console.error("[ewb][invoice-pdf] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

// ---------------------------------------------------------------------------
// POST /ewaybill/seed — one-click IRN-verified + dispatch-ready demo invoices
// ---------------------------------------------------------------------------

/**
 * Demo seed: two customers + two sales invoices that look exactly like
 * Phase 5-completed vouchers (status COMPLETED, Tally voucher number +
 * reference captured, IRN_GENERATED) with the dispatch snapshot already
 * filled in — so "Request e-way bill" succeeds in one click. Idempotent:
 * existing invoice numbers are updated (never duplicated) so a re-seed
 * repairs the demo state.
 */
router.post("/ewaybill/seed", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;

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
        irn: "TEST-IRN-001",
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
        irn: "TEST-IRN-002",
        buyer_gstin: "27AAHCG1234B1Z5",
      },
    ];

    // Dispatch snapshot shared by the demo invoices (one-click EWB request).
    const dispatchSnapshot = {
      tally_company_name: "Demo Company",
      seller_gstin: "27AAPCS1234F1Z5",
      billing_address: "101 MG Road, Bengaluru, Karnataka 560001",
      shipping_address: "201 Andheri West, Mumbai, Maharashtra 400072",
      place_of_supply: "27-Maharashtra",
      hsn: "8471",
      taxable_value: 10000,
      gst_amount: 1800,
      cgst: 900,
      sgst: 900,
      igst: 0,
      cess: 0,
      dispatch_warehouse: "Main Warehouse",
      origin_address: "101 MG Road, Bengaluru, Karnataka 560001",
      origin_pin: "560001",
      destination_address: "201 Andheri West, Mumbai, Maharashtra 400072",
      destination_pin: "400072",
      transporter_name: "Delhivery",
      transporter_id: "214243",
      transport_mode: "Road",
      vehicle_number: "KA01AB1234",
      transport_doc_number: "LR-1001",
      distance_km: 23,
      package_count: 10,
      package_type: "Boxes",
      irnStatus: "IRN_GENERATED",
      ewayBillStatus: "EWB_PENDING",
      dispatchStatus: "DISPATCH_PENDING",
      inventoryStatus: "INVENTORY_NOT_DEDUCTED",
    };

    let created = 0;
    let skipped = 0;
    const invoices: Array<Record<string, unknown>> = [];
    for (const d of demos) {
      const customerId = customerIds[d.customerName];
      const snapshot = {
        ...dispatchSnapshot,
        transport_doc_date: d.issue_date,
        expected_dispatch_date: d.issue_date,
        taxable_value: d.quantity * d.unit_price,
        package_count: d.quantity,
      };
      const dupe = await findInvoiceByNumber(userId, customerId, d.invoice_number).catch(() => undefined);
      if (dupe) {
        // Repair the demo state (IRN + dispatch snapshot) without duplicating.
        // Never clobber an already-generated e-way bill or its dispatch state.
        const repair: Record<string, unknown> = {
          status: "COMPLETED",
          tally_voucher_number: d.tally_voucher_number,
          tally_reference: d.tally_reference,
          irn: d.irn,
          ...snapshot,
        };
        if (str(dupe.ewayBillNumber)) {
          delete repair.ewayBillStatus;
          delete repair.dispatchStatus;
          delete repair.inventoryStatus;
        }
        await updateInvoice(userId, String(dupe.id), repair);
        skipped++;
        invoices.push(((await getInvoice(userId, String(dupe.id))) ?? dupe) as Record<string, unknown>);
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
        sync_status: "COMPLETED",
        synced_at: new Date().toISOString(),
        // Phase 5 IRN (as the IRN flow would store it).
        irn: d.irn,
        acknowledgementNumber: "123456789012345",
        acknowledgementDate: d.issue_date,
        irnGeneratedAt: new Date().toISOString(),
        buyer_gstin: d.buyer_gstin,
        ...snapshot,
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
        irn: r.irn,
        irnStatus: r.irnStatus ?? "IRN_GENERATED",
        ewayBillStatus: r.ewayBillStatus ?? "EWB_PENDING",
      })),
    });
  } catch (err) {
    console.error("[ewb][seed] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

export function isEwbStatus(value: unknown): value is (typeof EWB_STATUSES)[number] {
  return (EWB_STATUSES as readonly string[]).includes(String(value));
}

/** Transport modes accepted by the dispatch form (§2). */
export function isTransportMode(value: unknown): boolean {
  return (TRANSPORT_MODES as readonly string[]).includes(String(value));
}

export default router;
