/**
 * TallyPrime integration constants.
 */

export const MODULE_ROOT = "/api/integrations/tally";

/** Entity types supported for record ingestion (v1). */
export const RECORD_ENTITY_TYPES = [
  "COMPANY",
  "GROUP",
  "LEDGER",
  "STOCK_GROUP",
  "STOCK_CATEGORY",
  "STOCK_ITEM",
  "UNIT",
  "GODOWN",
  "VOUCHER_TYPE",
  "SALES_VOUCHER",
  "PURCHASE_VOUCHER",
  "RECEIPT_VOUCHER",
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
] as const;

/** Report types — sync architecture scaffolded; query XML is configurable, never guessed. */
export const REPORT_ENTITY_TYPES = [
  "BALANCE_SHEET",
  "PROFIT_LOSS",
  "TRIAL_BALANCE",
  "DAY_BOOK",
  "OUTSTANDING_RECEIVABLES",
  "OUTSTANDING_PAYABLES",
  "STOCK_SUMMARY",
  "GST_REPORTS",
] as const;

export const ALL_ENTITY_TYPES = [...RECORD_ENTITY_TYPES, ...REPORT_ENTITY_TYPES] as const;

export type RecordEntityType = (typeof RECORD_ENTITY_TYPES)[number];
export type ReportEntityType = (typeof REPORT_ENTITY_TYPES)[number];
export type EntityType = (typeof ALL_ENTITY_TYPES)[number];

export const SYNC_TYPES = [
  "INITIAL_SYNC",
  "INCREMENTAL_SYNC",
  "MANUAL_SYNC",
  "RETRY_SYNC",
  "FULL_RESYNC",
] as const;

export type SyncType = (typeof SYNC_TYPES)[number];

export const SYNC_SESSION_STATUSES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
] as const;

export type SyncSessionStatus = (typeof SYNC_SESSION_STATUSES)[number];

export const CONNECTOR_STATUSES = ["PENDING", "ONLINE", "OFFLINE", "REVOKED"] as const;

/** Default batch limits (overridable via env). */
export const DEFAULT_BATCH_MAX_RECORDS = 500;
export const DEFAULT_BATCH_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/** Pairing code format: WZK-XXXX-XXXX (no ambiguous characters). */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_PREFIX = "WZK";
