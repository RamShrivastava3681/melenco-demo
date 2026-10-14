/**
 * Phase 5: IRN (Invoice Reference Number) generation through Tally.
 *
 * Workflow (mock IRP — government portal access is NOT available):
 *   WhizUnik approved invoice (posted to Tally, status COMPLETED)
 *   → IRN preflight validation
 *   → IRN request built from the verified voucher
 *   → submitted via the configured IRNAdapter (MockIRNAdapter today)
 *   → response stored on the invoice, irnStatus transitions
 *
 * TEST-IRN-001 and friends are mock values. They are NEVER legally valid
 * IRNs — the status view and audit trail always carry `testMode: true`
 * while the mock adapter is in use.
 */
import { GSTIN_REGEX } from "../whizunik/validate.js";

// ---------------------------------------------------------------------------
// 1. IRN status flow (§1)
// ---------------------------------------------------------------------------

export const IRN_STATUSES = [
  "IRN_NOT_REQUIRED",
  "IRN_PENDING",
  "IRN_REQUEST_READY",
  "IRN_SUBMITTED",
  "IRN_GENERATED",
  "IRN_FAILED",
  "IRN_RETRYABLE",
  "IRN_CANCELLED",
] as const;

export type IrnStatus = (typeof IRN_STATUSES)[number];

/** Compliance is complete only in one of these states. */
export function isIrnComplianceComplete(status: string | null | undefined): boolean {
  return status === "IRN_GENERATED" || status === "IRN_NOT_REQUIRED";
}

// ---------------------------------------------------------------------------
// 2. IRN request shape (§2) — built ONLY from verified voucher data
// ---------------------------------------------------------------------------

export interface IrnItem {
  skuCode: string | null;
  description: string | null;
  hsn: string | null;
  quantity: number | null;
  unit: string | null;
  taxableValue: number | null;
  gstRate: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  cess: number | null;
}

export interface IrnRequest {
  whizunikInvoiceId: string;
  whizunikInvoiceNumber: string;
  tallyVoucherNumber: string;
  tallyReference: string;
  invoiceDate: string;
  sellerGstin: string;
  buyerGstin: string | null;
  buyerName: string;
  billingAddress: string | null;
  shippingAddress: string | null;
  placeOfSupply: string | null;
  items: IrnItem[];
  invoiceTotal: number | null;
  supplyType: string;
  documentType: string;
  idempotencyKey: string;
  requestId: string;
  /** Always true while the mock IRP is the configured route. */
  testMode: boolean;
}

export type IrnAdapterStatus = "SUCCESS" | "REJECTED" | "RETRYABLE_ERROR" | "DUPLICATE";

export interface IrnAdapterResponse {
  status: IrnAdapterStatus;
  irn?: string;
  ackNumber?: string;
  ackDate?: string;
  signedInvoice?: string;
  signedQrCode?: string;
  errorCode?: string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// 4. IRN adapter interface (§4, §11)
// ---------------------------------------------------------------------------

/**
 * Adapter interface. Swapping MockIRNAdapter → ProductionIRNAdapter must not
 * change the invoice workflow, voucher workflow, status model, duplicate
 * protection, retry handling or audit logging — only this implementation.
 */
export interface IRNAdapter {
  readonly name: string;
  readonly testMode: boolean;
  submit(request: IrnRequest): Promise<IrnAdapterResponse>;
}

export type MockIrpMode = "SUCCESS" | "REJECTED" | "RETRYABLE_ERROR" | "DUPLICATE";

/**
 * Mock IRP for current testing (§5). In AUTO mode it behaves like a strict
 * IRP: structurally invalid GSTINs are REJECTED, everything well-formed
 * succeeds. A forced mode simulates IRP outages / duplicates in tests.
 */
export class MockIRNAdapter implements IRNAdapter {
  readonly name = "MockIRNAdapter";
  readonly testMode = true;

  constructor(private forcedMode: MockIrpMode | "AUTO" = "AUTO") {}

  async submit(request: IrnRequest): Promise<IrnAdapterResponse> {
    const mode: MockIrpMode = this.forcedMode === "AUTO" ? this.autoMode(request) : this.forcedMode;
    switch (mode) {
      case "SUCCESS":
        return {
          status: "SUCCESS",
          irn: "TEST-IRN-001",
          ackNumber: "TEST-ACK-001",
          ackDate: "2026-10-13",
          signedInvoice: "TEST-SIGNED-DATA",
          signedQrCode: "TEST-QR-DATA",
        };
      case "REJECTED":
        return {
          status: "REJECTED",
          errorCode: "INVALID_GSTIN",
          errorMessage: "Buyer GSTIN is invalid",
        };
      case "RETRYABLE_ERROR":
        return {
          status: "RETRYABLE_ERROR",
          errorCode: "IRP_UNAVAILABLE",
          errorMessage: "IRP temporarily unavailable",
        };
      case "DUPLICATE":
        return {
          status: "DUPLICATE",
          irn: "TEST-IRN-001",
          ackNumber: "TEST-ACK-001",
        };
    }
  }

  private autoMode(request: IrnRequest): MockIrpMode {
    const sellerOk = GSTIN_REGEX.test(String(request.sellerGstin || "").toUpperCase());
    const buyerOk =
      request.buyerGstin === null || GSTIN_REGEX.test(String(request.buyerGstin).toUpperCase());
    if (!sellerOk || !buyerOk) return "REJECTED";
    return "SUCCESS";
  }
}

/**
 * Production placeholder (§11). Connects to the authorised IRP/GSP or the
 * agreed Tally compliance route when government access is available.
 * Same request/response contract as the mock — workflow code is untouched.
 */
export class ProductionIRNAdapter implements IRNAdapter {
  readonly name = "ProductionIRNAdapter";
  readonly testMode = false;

  async submit(_request: IrnRequest): Promise<IrnAdapterResponse> {
    throw new Error(
      "ProductionIRNAdapter is not configured: government IRP/GSP access is not yet available. " +
        "Configure the authorised IRP/GSP route before switching off the mock adapter."
    );
  }
}

// ---------------------------------------------------------------------------
// 8. Idempotency (§8)
// ---------------------------------------------------------------------------

/** irn:{sellerGstin}:{invoiceNumber}:{invoiceDate} */
export function irnIdempotencyKey(sellerGstin: string, invoiceNumber: string, invoiceDate: string): string {
  return `irn:${String(sellerGstin).trim().toUpperCase()}:${String(invoiceNumber).trim()}:${String(invoiceDate).slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// 3. IRN preflight validation (§3)
// ---------------------------------------------------------------------------

export interface PreflightFailure {
  missingField: string;
  action: string;
}

export interface PreflightResult {
  ok: boolean;
  failures: PreflightFailure[];
}

/** Amount reconciliation tolerance (paise rounding). */
const AMOUNT_TOLERANCE = 1.0;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export interface PreflightInput {
  sellerGstin?: string | null;
  buyerGstin?: string | null;
  /** Set when the buyer is unregistered (B2C) — GSTIN not required. */
  buyerName?: string | null;
  billingAddress?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  voucherExistsInTally?: boolean;
  tallyReference?: string | null;
  hsn?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  taxableValue?: number | null;
  gstRate?: number | null;
  cgst?: number | null;
  sgst?: number | null;
  igst?: number | null;
  cess?: number | null;
  grandTotal?: number | null;
  placeOfSupply?: string | null;
  alreadyHasIrn?: boolean;
  tallyVoucherNumber?: string | null;
}

const fail = (missingField: string, action: string): PreflightFailure => ({ missingField, action });

/**
 * Preflight checks. Returns EVERY failure (not just the first) so the caller
 * can surface the exact missing field(s); the request is never submitted
 * while any failure remains.
 */
export function preflightIrn(input: PreflightInput): PreflightResult {
  const failures: PreflightFailure[] = [];

  if (!input.sellerGstin || !GSTIN_REGEX.test(String(input.sellerGstin).trim().toUpperCase())) {
    failures.push(fail("Seller GSTIN", "Complete the seller/company tax details and retry."));
  }
  const buyerGstin = String(input.buyerGstin ?? "").trim();
  if (!buyerGstin) {
    if (!input.buyerName || !String(input.buyerName).trim()) {
      failures.push(
        fail("Buyer GSTIN", "Complete the customer tax details (GSTIN, or buyer name for unregistered buyers) and retry.")
      );
    }
  } else if (!GSTIN_REGEX.test(buyerGstin.toUpperCase())) {
    failures.push(fail("Buyer GSTIN", "Buyer GSTIN is invalid. Correct the customer tax details and retry."));
  }
  if (!input.invoiceNumber || !String(input.invoiceNumber).trim()) {
    failures.push(fail("Invoice number", "The invoice number is missing. Re-sync the voucher and retry."));
  }
  if (!input.invoiceDate || !String(input.invoiceDate).trim()) {
    failures.push(fail("Invoice date", "The invoice date is missing. Re-sync the voucher and retry."));
  }
  if (!input.voucherExistsInTally) {
    failures.push(fail("Tally voucher", "Voucher does not exist in Tally. Post the voucher first and retry."));
  }
  if (!input.tallyReference || !String(input.tallyReference).trim()) {
    failures.push(fail("Tally reference", "Tally reference is unavailable. Re-sync the voucher and retry."));
  }
  if (!input.hsn || !String(input.hsn).trim()) {
    failures.push(fail("HSN", "Complete the SKU HSN code and retry."));
  }
  const qty = num(input.quantity);
  if (qty === null || qty <= 0) {
    failures.push(fail("Quantity", "Complete the line quantity and retry."));
  }
  const gstRate = num(input.gstRate);
  if (gstRate === null) {
    failures.push(fail("Tax rate", "Complete the GST rate and retry."));
  }
  if (!input.placeOfSupply || !String(input.placeOfSupply).trim()) {
    failures.push(fail("Place of supply", "Complete the place of supply and retry."));
  }
  if (input.alreadyHasIrn) {
    failures.push(fail("IRN already assigned", "This invoice already has an IRN. Duplicate request blocked."));
  }

  // Tax reconciliation: CGST+SGST+IGST must equal taxable × rate.
  const taxable = num(input.taxableValue) ?? (qty !== null && num(input.unitPrice) !== null ? qty * Number(input.unitPrice) : null);
  const cgst = num(input.cgst) ?? 0;
  const sgst = num(input.sgst) ?? 0;
  const igst = num(input.igst) ?? 0;
  const cess = num(input.cess) ?? 0;
  const grandTotal = num(input.grandTotal);
  if (taxable !== null && gstRate !== null) {
    const expectedTax = (taxable * gstRate) / 100;
    const actualTax = cgst + sgst + igst;
    if (Math.abs(expectedTax - actualTax) > AMOUNT_TOLERANCE) {
      failures.push(
        fail(
          "Tax amounts",
          `Tax amounts do not reconcile: expected ${expectedTax.toFixed(2)} (taxable ${taxable.toFixed(2)} × ${gstRate}%), got ${actualTax.toFixed(2)}. Correct CGST/SGST/IGST and retry.`
        )
      );
    }
    if (grandTotal !== null && Math.abs(taxable + actualTax + cess - grandTotal) > AMOUNT_TOLERANCE) {
      failures.push(
        fail(
          "Grand total",
          `Grand total does not reconcile: expected ${(taxable + actualTax + cess).toFixed(2)}, got ${grandTotal.toFixed(2)}. Correct the totals and retry.`
        )
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

/** Human-readable preflight error (§3 example format). */
export function formatPreflightError(result: PreflightResult): string {
  const first = result.failures[0];
  if (!first) return "IRN preflight failed.";
  return `IRN cannot be requested.\nMissing field: ${first.missingField}\nAction: ${first.action}`;
}

/** Map an adapter response to the invoice IRN status. */
export function irnStatusForResponse(response: IrnAdapterResponse): IrnStatus {
  switch (response.status) {
    case "SUCCESS":
    case "DUPLICATE":
      return "IRN_GENERATED";
    case "REJECTED":
      return "IRN_FAILED";
    case "RETRYABLE_ERROR":
      return "IRN_RETRYABLE";
  }
}
