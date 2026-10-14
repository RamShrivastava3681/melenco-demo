/**
 * Phase 6: E-way bill generation after Tally voucher + IRN verification.
 *
 * Workflow (mock e-way bill adapter — government portal access is NOT available):
 *   WhizUnik invoice (posted to Tally, status COMPLETED, IRN_GENERATED)
 *   → dispatch details entered
 *   → EWB preflight validation
 *   → EWB request built from verified invoice + dispatch data
 *   → submitted via the configured EWayBillAdapter (MockEWayBillAdapter today)
 *   → response stored on the invoice, ewayBillStatus transitions
 *   → dispatch released ONLY on EWB_GENERATED → inventory deducted
 *
 * TEST values are freshly generated per request (random 12-digit e-way bill
 * numbers like the real portal issues, generation date = today, validity
 * derived from distance — never hardcoded, never legally valid) — the status
 * view, PDF and audit trail always carry `environment: "MOCK"` +
 * `legallyValid: false` while the mock adapter is in use.
 */
import { randomInt } from "node:crypto";
import { GSTIN_REGEX } from "../whizunik/validate.js";

// ---------------------------------------------------------------------------
// 1. E-way bill statuses (§1)
// ---------------------------------------------------------------------------

export const EWB_STATUSES = [
  "EWB_NOT_REQUIRED",
  "EWB_PENDING",
  "EWB_REQUEST_READY",
  "EWB_SUBMITTED",
  "EWB_GENERATED",
  "EWB_FAILED",
  "EWB_RETRYABLE",
  "EWB_CANCELLED",
  "EWB_EXPIRED",
] as const;

export type EwbStatus = (typeof EWB_STATUSES)[number];

/** Dispatch may be released only in one of these states. */
export function isEwbDispatchReleasable(status: string | null | undefined): boolean {
  return status === "EWB_GENERATED" || status === "EWB_NOT_REQUIRED";
}

export const TRANSPORT_MODES = ["Road", "Rail", "Air", "Ship"] as const;

// ---------------------------------------------------------------------------
// 5. E-way bill request shape (§5) — verified invoice + dispatch data only
// ---------------------------------------------------------------------------

export interface EwbItem {
  skuCode: string | null;
  description: string | null;
  hsn: string | null;
  quantity: number | null;
  unit: string | null;
  taxableValue: number | null;
  gstRate: number | null;
  gstAmount: number | null;
}

export interface EwbRequest {
  whizunikInvoiceId: string;
  whizunikInvoiceNumber: string;
  tallyVoucherNumber: string;
  tallyReference: string;
  invoiceDate: string;
  invoiceValue: number | null;
  irn: string;
  sellerGstin: string;
  buyerGstin: string | null;
  buyerName: string;
  originAddress: string | null;
  originPin: string | null;
  destinationAddress: string | null;
  destinationPin: string | null;
  placeOfSupply: string | null;
  items: EwbItem[];
  quantity: number | null;
  taxableValue: number | null;
  gstAmount: number | null;
  transportMode: string;
  transporterName: string | null;
  transporterId: string | null;
  vehicleNumber: string | null;
  transportDocNumber: string | null;
  transportDocDate: string | null;
  distanceKm: number | null;
  idempotencyKey: string;
  requestId: string;
  /** Always true while the mock adapter is the configured route. */
  testMode: boolean;
}

export type EwbAdapterStatus = "SUCCESS" | "REJECTED" | "RETRYABLE_ERROR" | "DUPLICATE";

export interface EwbAdapterResponse {
  status: EwbAdapterStatus;
  ewayBillNumber?: string;
  generatedDate?: string;
  validUntil?: string;
  vehicleNumber?: string;
  errorCode?: string;
  errorMessage?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// 4. E-way bill adapter interface (§4, §14)
// ---------------------------------------------------------------------------

/**
 * Adapter interface. Swapping MockEWayBillAdapter → ProductionEWayBillAdapter
 * must not change the invoice/dispatch workflow, status model, duplicate
 * protection, retry handling or audit logging — only this implementation.
 */
export interface EWayBillAdapter {
  readonly name: string;
  readonly testMode: boolean;
  submit(request: EwbRequest): Promise<EwbAdapterResponse>;
}

export type MockEwbMode =
  | "SUCCESS"
  | "INVALID_VEHICLE"
  | "INVALID_PIN"
  | "IRN_INVALID"
  | "RETRYABLE_ERROR"
  | "DUPLICATE";

/**
 * Mock e-way bill adapter for current testing (§6). In AUTO mode it behaves
 * like a strict portal: invalid vehicles / PINs / IRNs are REJECTED,
 * everything well-formed succeeds. A forced mode simulates portal outages /
 * duplicates in tests.
 *
 * Nothing is user-visible as legal: every SUCCESS response carries
 * `environment: "MOCK"` + `legallyValid: false` (surfaced by the route).
 */
export class MockEWayBillAdapter implements EWayBillAdapter {
  readonly name = "MockEWayBillAdapter";
  readonly testMode = true;

  constructor(private forcedMode: MockEwbMode | "AUTO" = "AUTO") {}

  async submit(request: EwbRequest): Promise<EwbAdapterResponse> {
    const mode: MockEwbMode = this.forcedMode === "AUTO" ? this.autoMode(request) : this.forcedMode;
    switch (mode) {
      case "SUCCESS":
        return { status: "SUCCESS", ...generateMockEwb(request) };
      case "INVALID_VEHICLE":
        return {
          status: "REJECTED",
          errorCode: "INVALID_VEHICLE",
          errorMessage: "Vehicle number is invalid",
        };
      case "INVALID_PIN":
        return {
          status: "REJECTED",
          errorCode: "INVALID_PIN",
          errorMessage: "Destination PIN code is invalid",
        };
      case "IRN_INVALID":
        return {
          status: "REJECTED",
          errorCode: "IRN_INVALID",
          errorMessage: "IRN is cancelled or expired",
        };
      case "RETRYABLE_ERROR":
        return {
          status: "RETRYABLE_ERROR",
          errorCode: "EWB_SERVICE_UNAVAILABLE",
          errorMessage: "E-way bill service temporarily unavailable",
        };
      case "DUPLICATE": {
        const generated = generateMockEwb(request);
        return {
          status: "DUPLICATE",
          ewayBillNumber: generated.ewayBillNumber,
          message: "E-way bill already exists for this invoice",
        };
      }
    }
  }

  private autoMode(request: EwbRequest): MockEwbMode {
    if (!isValidVehicle(request.vehicleNumber)) return "INVALID_VEHICLE";
    if (!isValidPin(request.originPin) || !isValidPin(request.destinationPin)) return "INVALID_PIN";
    return "SUCCESS";
  }
}

/** Loose vehicle check: present + plausible registration (TEST-* accepted for mocks). */
export function isValidVehicle(v: string | null | undefined): boolean {
  const s = String(v ?? "").trim();
  if (!s) return false;
  return /^[A-Z0-9][A-Z0-9\s-]{3,19}$/i.test(s);
}

/** Indian PIN: exactly 6 digits, first digit non-zero. */
export function isValidPin(v: string | null | undefined): boolean {
  return /^[1-9][0-9]{5}$/.test(String(v ?? "").trim());
}

export interface GeneratedMockEwb {
  ewayBillNumber: string;
  generatedDate: string;
  validUntil: string;
  vehicleNumber: string;
}

function addDays(dateIso: string, days: number): string {
  const m = String(dateIso || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const base = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : new Date();
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Portal rule of thumb: 1 day of validity per 200 km (minimum 1 day). */
export function validityDaysForDistance(distanceKm: number | null | undefined): number {
  const km = Number(distanceKm);
  if (!Number.isFinite(km) || km <= 0) return 1;
  return Math.max(1, Math.ceil(km / 200));
}

/** Random 12-digit e-way bill number, as the real portal issues. */
export function randomEwayBillNumber(): string {
  return String(randomInt(100000000000, 1000000000000));
}

/**
 * Fresh mock e-way bill values per request — nothing is hardcoded and
 * nothing is reused: every SUCCESS call mints a new random 12-digit number
 * with generation date = today and distance-based validity. Retries and
 * duplicate deliveries stay safe because the route persists the FIRST
 * generated number on the invoice (idempotency key
 * `ewb:{sellerGstin}:{invoiceNumber}:{invoiceDate}`) and returns the stored
 * value instead of minting a second one.
 */
export function generateMockEwb(
  request: Pick<EwbRequest, "vehicleNumber" | "distanceKm">
): GeneratedMockEwb {
  const generatedDate = new Date().toISOString().slice(0, 10);
  return {
    ewayBillNumber: randomEwayBillNumber(),
    generatedDate,
    validUntil: addDays(generatedDate, validityDaysForDistance(request.distanceKm)),
    vehicleNumber: String(request.vehicleNumber || "").trim() || "TEST-1234",
  };
}

/**
 * Production placeholder (§14). Connects through the configured
 * Tally/compliance route or authorised government integration when
 * available. Same request/response contract as the mock — untouched workflow.
 */
export class ProductionEWayBillAdapter implements EWayBillAdapter {
  readonly name = "ProductionEWayBillAdapter";
  readonly testMode = false;

  async submit(_request: EwbRequest): Promise<EwbAdapterResponse> {
    throw new Error(
      "ProductionEWayBillAdapter is not configured: government e-way bill access is not yet available. " +
        "Configure the authorised e-way bill route before switching off the mock adapter."
    );
  }
}

// ---------------------------------------------------------------------------
// Idempotency: ewb:{sellerGstin}:{invoiceNumber}:{invoiceDate} (§5)
// ---------------------------------------------------------------------------

export function ewbIdempotencyKey(sellerGstin: string, invoiceNumber: string, invoiceDate: string): string {
  return `ewb:${String(sellerGstin).trim().toUpperCase()}:${String(invoiceNumber).trim()}:${String(invoiceDate).slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// 3. EWB preflight validation (§3 + Preconditions)
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
  irn?: string | null;
  irnStatus?: string | null;
  voucherExistsInTally?: boolean;
  invoiceNumber?: string | null;
  tallyReference?: string | null;
  sellerGstin?: string | null;
  buyerGstin?: string | null;
  buyerName?: string | null;
  originAddress?: string | null;
  originPin?: string | null;
  destinationAddress?: string | null;
  destinationPin?: string | null;
  transportMode?: string | null;
  transporterName?: string | null;
  vehicleNumber?: string | null;
  transportDocNumber?: string | null;
  dispatchWarehouse?: string | null;
  taxableValue?: number | null;
  gstAmount?: number | null;
  invoiceTotal?: number | null;
  alreadyHasEwb?: boolean;
}

const fail = (missingField: string, action: string): PreflightFailure => ({ missingField, action });

/**
 * Preflight checks. Returns EVERY failure (not just the first) so the caller
 * can surface the exact missing field(s); the request is never submitted
 * while any failure remains.
 */
export function preflightEwb(input: PreflightInput): PreflightResult {
  const failures: PreflightFailure[] = [];

  if (!input.voucherExistsInTally) {
    failures.push(fail("Tally voucher", "Post the invoice to Tally first (invoice must be COMPLETED) and retry."));
  }
  if (!input.invoiceNumber || !String(input.invoiceNumber).trim()) {
    failures.push(fail("Invoice number", "The invoice number is missing. Re-sync the voucher and retry."));
  }
  if (!input.tallyReference || !String(input.tallyReference).trim()) {
    failures.push(fail("Tally reference", "Re-sync the voucher so the Tally reference is captured, then retry."));
  } else if (
    input.invoiceNumber &&
    String(input.tallyReference).trim() !== String(input.invoiceNumber).trim()
  ) {
    failures.push(
      fail("Tally reference", "Tally reference does not match the WhizUnik invoice. Re-sync the voucher and retry.")
    );
  }
  if (!input.irn || !String(input.irn).trim()) {
    failures.push(fail("IRN", "Generate the IRN first (IRN status must be IRN_GENERATED) and retry."));
  } else if (input.irnStatus && input.irnStatus !== "IRN_GENERATED") {
    failures.push(
      fail("IRN", `IRN is ${input.irnStatus}. Only an IRN_GENERATED invoice can request an e-way bill.`)
    );
  }
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
  if (!input.dispatchWarehouse || !String(input.dispatchWarehouse).trim()) {
    failures.push(fail("Dispatch warehouse", "Select the dispatch warehouse and retry."));
  }
  if (!input.originAddress || !String(input.originAddress).trim()) {
    failures.push(fail("Origin address", "Complete the origin (dispatch-from) address and retry."));
  }
  if (!isValidPin(input.originPin)) {
    failures.push(fail("Origin PIN", "Origin PIN code is invalid. Enter a 6-digit PIN and retry."));
  }
  if (!input.destinationAddress || !String(input.destinationAddress).trim()) {
    failures.push(fail("Destination address", "Complete the destination (ship-to) address and retry."));
  }
  if (!isValidPin(input.destinationPin)) {
    failures.push(fail("Destination PIN", "Destination PIN code is invalid. Enter a 6-digit PIN and retry."));
  }
  if (!input.transportMode || !(TRANSPORT_MODES as readonly string[]).includes(String(input.transportMode).trim())) {
    failures.push(fail("Transport mode", `Select the transport mode (${TRANSPORT_MODES.join(", ")}) and retry.`));
  }
  if (!input.transporterName || !String(input.transporterName).trim()) {
    failures.push(fail("Transporter", "Enter the transporter name and retry."));
  }
  if (!input.vehicleNumber || !String(input.vehicleNumber).trim()) {
    failures.push(fail("Vehicle number", "Enter the vehicle number and retry."));
  } else if (!isValidVehicle(input.vehicleNumber)) {
    failures.push(fail("Vehicle number", "Vehicle number is invalid. Correct it and retry."));
  }
  if (input.alreadyHasEwb) {
    failures.push(fail("E-way bill already assigned", "This invoice already has an e-way bill. Duplicate request blocked."));
  }

  // Amount reconciliation: taxable + GST must equal the invoice total.
  const taxable = num(input.taxableValue);
  const gst = num(input.gstAmount) ?? 0;
  const total = num(input.invoiceTotal);
  if (taxable !== null && total !== null && Math.abs(taxable + gst - total) > AMOUNT_TOLERANCE) {
    failures.push(
      fail(
        "Invoice total",
        `Invoice total does not reconcile: expected ${(taxable + gst).toFixed(2)} (taxable ${taxable.toFixed(2)} + GST ${gst.toFixed(2)}), got ${total.toFixed(2)}. Correct the totals and retry.`
      )
    );
  }

  return { ok: failures.length === 0, failures };
}

/** Human-readable preflight error (§3 example format). */
export function formatPreflightError(result: PreflightResult): string {
  const first = result.failures[0];
  if (!first) return "E-way bill preflight failed.";
  return `E-way bill cannot be requested.\nMissing field: ${first.missingField}\nAction: ${first.action}`;
}

/** Map an adapter response to the invoice e-way bill status. */
export function ewbStatusForResponse(response: EwbAdapterResponse): EwbStatus {
  switch (response.status) {
    case "SUCCESS":
    case "DUPLICATE":
      return "EWB_GENERATED";
    case "REJECTED":
      return "EWB_FAILED";
    case "RETRYABLE_ERROR":
      return "EWB_RETRYABLE";
  }
}
