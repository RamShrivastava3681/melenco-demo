import { z } from "zod";
import db from "../../../db/index.js";
import { v4 as uuidv4 } from "uuid";
import { ApiError } from "../errors.js";
import { normalizeMaster, MASTER_TARGETS } from "./masters.js";
import { normalizeVoucher, VOUCHER_TARGETS } from "./vouchers.js";

export interface NormalizedResult {
  table: string;
  recordId: string;
}

export interface BatchRecord {
  sourceObjectId?: string;
  tallyGuid?: string;
  voucherType?: string | null;
  voucherNumber?: string | null;
  voucherDate?: string | null;
  partyName?: string | null;
  amount?: number | null;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BatchInput {
  syncId: string;
  companyId: string;
  entityType: string;
  batchNumber: number;
  totalBatches: number;
  records: BatchRecord[];
}

export interface NormalizeContext {
  userId: string;
  companyId: string;
  entityType: string;
  record: BatchRecord;
  sourceObjectId: string;
}

/**
 * Dispatch a single record to its normalizer.
 * Throws ApiError (TALLY_DATA_INVALID / NORMALIZATION_FAILED) on failure —
 * the batch processor converts that into per-record failure counts.
 */
export function normalizeRecord(ctx: NormalizeContext): NormalizedResult {
  const entityType = ctx.entityType;

  if (entityType in MASTER_TARGETS) {
    return normalizeMaster(ctx);
  }
  if (entityType in VOUCHER_TARGETS || VOUCHER_ENTITY_TYPES.has(entityType)) {
    // Explicit targets (sales/receipt/purchase) plus all other voucher types
    // go through the voucher normalizer, which falls back to the generic
    // tally_vouchers store so no data is ever dropped.
    return normalizeVoucher(ctx);
  }
  // Report payloads land in the report store
  return storeReportOrOther(ctx);
}

export function getNormalizedTargetTable(entityType: string): string {
  if (entityType in MASTER_TARGETS) return MASTER_TARGETS[entityType].table;
  if (entityType in VOUCHER_TARGETS) return VOUCHER_TARGETS[entityType].table;
  return "tally_reports";
}

function storeReportOrOther(ctx: NormalizeContext): NormalizedResult {
  if (REPORT_TYPES.has(ctx.entityType)) {
    const id = uuidv4();
    db.prepare(
      `INSERT OR IGNORE INTO tally_reports (id, user_id, company_id, report_type, report_date, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      ctx.userId,
      ctx.companyId,
      ctx.entityType,
      (ctx.record.voucherDate as string) || null,
      JSON.stringify(ctx.record.data ?? ctx.record)
    );
    return { table: "tally_reports", recordId: id };
  }
  throw new ApiError("NORMALIZATION_FAILED", `Unsupported entity type ${ctx.entityType}`);
}

const REPORT_TYPES = new Set([
  "BALANCE_SHEET",
  "PROFIT_LOSS",
  "TRIAL_BALANCE",
  "DAY_BOOK",
  "OUTSTANDING_RECEIVABLES",
  "OUTSTANDING_PAYABLES",
  "STOCK_SUMMARY",
  "GST_REPORTS",
]);

/** Voucher-like entity types handled by the voucher normalizer (generic store fallback). */
const VOUCHER_ENTITY_TYPES = new Set([
  "PAYMENT_VOUCHER",
  "JOURNAL_VOUCHER",
  "CONTRA_VOUCHER",
  "DEBIT_NOTE",
  "CREDIT_NOTE",
  "SALES_ORDER",
  "PURCHASE_ORDER",
  "DELIVERY_NOTE",
  "RECEIPT_NOTE",
  "STOCK_JOURNAL",
]);

export { z };
