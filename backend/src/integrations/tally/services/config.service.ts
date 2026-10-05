import db from "../../../db/index.js";
import { config } from "../utils/env.js";
import { RECORD_ENTITY_TYPES, REPORT_ENTITY_TYPES } from "../constants.js";
import { listCheckpointsForCompany } from "./checkpoint.service.js";

/**
 * Sync configuration served to the local connector via GET /config.
 * The connector never invents incremental-sync logic — it follows this config,
 * including per-entity checkpoints and declarative report query definitions.
 */

export interface EntitySyncConfig {
  entityType: string;
  enabled: boolean;
  syncOrder: number;
  incrementalField: "NONE" | "MODIFIED_DATE" | "VOUCHER_DATE" | "OBJECT_ID";
  batchSize: number;
}

// v1 policy: masters first (dependency order), then vouchers. Configurable via env later.
const SYNC_ORDER: Record<string, number> = {
  COMPANY: 0,
  GROUP: 10,
  LEDGER: 20,
  UNIT: 30,
  STOCK_GROUP: 40,
  STOCK_CATEGORY: 50,
  STOCK_ITEM: 60,
  GODOWN: 70,
  VOUCHER_TYPE: 80,
  SALES_VOUCHER: 100,
  PURCHASE_VOUCHER: 110,
  RECEIPT_VOUCHER: 120,
  PAYMENT_VOUCHER: 130,
  JOURNAL_VOUCHER: 140,
  CONTRA_VOUCHER: 150,
  DEBIT_NOTE: 160,
  CREDIT_NOTE: 170,
  SALES_ORDER: 180,
  PURCHASE_ORDER: 190,
  DELIVERY_NOTE: 200,
  RECEIPT_NOTE: 210,
  STOCK_JOURNAL: 220,
};

// Entity types enabled by default (v1). Operators can trim via env TALLY_DISABLED_ENTITY_TYPES.
const DEFAULT_ENABLED = new Set<string>(RECORD_ENTITY_TYPES);

function disabledEntityTypes(): Set<string> {
  const raw = process.env.TALLY_DISABLED_ENTITY_TYPES || "";
  return new Set(raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
}

export function getEntityConfigs(): EntitySyncConfig[] {
  const disabled = disabledEntityTypes();
  return RECORD_ENTITY_TYPES.map((entityType) => ({
    entityType,
    enabled: DEFAULT_ENABLED.has(entityType) && !disabled.has(entityType),
    syncOrder: SYNC_ORDER[entityType] ?? 999,
    incrementalField:
      entityType.endsWith("VOUCHER") || entityType === "DEBIT_NOTE" || entityType === "CREDIT_NOTE"
        ? "VOUCHER_DATE"
        : entityType === "STOCK_JOURNAL" || entityType.endsWith("_NOTE") || entityType.endsWith("_ORDER")
          ? "OBJECT_ID"
          : "NONE",
    batchSize: config.batchMaxRecords,
  }));
}

/**
 * Full config payload for a tenant + company.
 * reportQueries are declarative placeholders — the cloud never guesses Tally
 * XML; operators supply per-version query definitions via env/config later.
 */
export function buildConnectorConfig(userId: string, companyId: string | null) {
  const checkpoints = companyId ? listCheckpointsForCompany(userId, companyId) : [];

  const reportQueries = Object.fromEntries(
    REPORT_ENTITY_TYPES.map((rt) => [rt, { enabled: false, queryTemplate: null as string | null }])
  );

  return {
    batchLimits: {
      maxRecords: config.batchMaxRecords,
      maxBytes: config.batchMaxBytes,
    },
    entities: getEntityConfigs().sort((a, b) => a.syncOrder - b.syncOrder),
    reports: reportQueries,
    checkpoints: checkpoints.map((cp) => ({
      entityType: cp.entity_type,
      lastSyncAt: cp.last_sync_at,
      lastObjectId: cp.last_object_id,
      lastVoucherDate: cp.last_voucher_date,
      lastVoucherNumber: cp.last_voucher_number,
    })),
    serverTime: new Date().toISOString(),
  };
}
