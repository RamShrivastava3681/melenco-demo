import { z } from "zod";

export const PAIRING_CODE_REGEX = /^WZK-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

// 1. POST /api/integrations/tally/connect
export const wzConnectSchema = z.object({
  pairingCode: z.string().trim().regex(PAIRING_CODE_REGEX, "pairingCode must match WZK-XXXX-XXXX"),
  deviceId: z.string().trim().min(1).max(120),
  deviceName: z.string().trim().min(1).max(120),
  appVersion: z.string().trim().min(1).max(40),
  protocolVersion: z.string().trim().min(1).max(40),
  company: z.object({
    name: z.string().trim().min(1).max(200),
    // Connector may send `tallyGuid: undefined` (dropped by JSON) or
    // explicit null when no GUID is known — accept both.
    tallyGuid: z.string().trim().max(200).nullish(),
  }),
});

// 2. POST /api/integrations/tally/token
export const wzTokenSchema = z.object({
  refreshToken: z.string().trim().min(1),
  deviceId: z.string().trim().min(1).max(120),
  connectorId: z.string().trim().min(1).max(120),
});

// 3. POST /api/integrations/tally/sync/batch
export const wzBatchRecordSchema = z
  .object({
    source: z.string().trim().min(1).max(40).optional().default("tally"),
    // Master records (groups, ledgers, units, …) have no voucher number or
    // date, so the connector sends explicit nulls. `.optional()` alone
    // rejects null — accept both null and undefined (missing).
    sourceCompanyId: z.string().trim().max(200).nullish(),
    entityType: z.string().trim().min(1).max(64),
    sourceObjectId: z.string().trim().max(200).nullish(),
    sourceVoucherNumber: z.string().trim().max(100).nullish(),
    sourceVoucherDate: z.string().trim().max(30).nullish(),
    data: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .passthrough();

export const wzBatchSchema = z.object({
  batchId: z.string().trim().min(1).max(128),
  requestId: z.string().trim().min(1).max(128),
  syncId: z.string().trim().min(1).max(128),
  deviceId: z.string().trim().min(1).max(120),
  companyId: z.string().trim().min(1).max(128),
  entityType: z.string().trim().min(1).max(64),
  batchNumber: z.number().int().positive().max(1_000_000),
  totalBatches: z.number().int().positive().max(1_000_000),
  records: z.array(wzBatchRecordSchema).min(0).max(5000),
});

// 4. POST /api/integrations/tally/heartbeat
export const wzHeartbeatSchema = z.object({
  connectorId: z.string().trim().min(1).max(120),
  deviceId: z.string().trim().min(1).max(120),
  appVersion: z.string().trim().min(1).max(40),
  protocolVersion: z.string().trim().min(1).max(40),
  // The connector sends explicit null when Tally is offline or no company
  // is selected yet — accept null as "unknown", not a validation error.
  tallyVersion: z.string().trim().max(80).nullish(),
  company: z.string().trim().max(200).nullish(),
  lastSync: z.string().trim().max(40).nullable().optional(),
  currentSync: z.unknown().nullable().optional(),
  status: z.enum(["idle", "running", "paused", "error"]),
});

// 5. POST /api/integrations/tally/updates
export const wzUpdatesSchema = z.object({
  appVersion: z.string().trim().min(1).max(40),
  protocolVersion: z.string().trim().min(1).max(40),
});

// Admin: POST /api/integrations/tally/admin/pairing-codes
export const wzAdminPairingSchema = z.object({
  tenantId: z.string().trim().min(1).max(128).optional(),
  tenantName: z.string().trim().max(200).optional(),
  companyName: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  tallyGuid: z.string().trim().max(200).optional(),
  tallyCompanyGuid: z.string().trim().max(200).optional(),
  ttlMinutes: z.number().int().positive().max(60 * 24 * 30).optional(),
});

// Platform push: POST /api/integrations/tally/commands (JWT)
export const WZ_COMMANDS = ["REQUEST_SYNC", "PAUSE_SYNC", "RESUME_SYNC", "UPDATE_CONFIG", "PUSH_VOUCHERS", "PUSH_MASTERS"] as const;

export const wzPushCommandSchema = z.object({
  connectorId: z.string().trim().min(1).max(120),
  command: z.enum(WZ_COMMANDS),
  payload: z.record(z.string(), z.unknown()).optional(),
});

// Platform push: POST /api/integrations/tally/invoices/push (JWT)
// Queues selected platform invoices as PUSH_VOUCHERS for the connector.
export const wzPushInvoicesSchema = z.object({
  connectorId: z.string().trim().min(1).max(120),
  companyId: z.string().trim().min(1).max(128),
  invoiceIds: z.array(z.string().trim().min(1).max(128)).min(1).max(200),
});

// Connector ack: POST /api/integrations/tally/commands/ack (Bearer)
export const wzAckCommandSchema = z.object({
  commandId: z.string().trim().min(1).max(128),
  status: z.enum(["DONE", "CANCELLED"]),
  // Phase 3 master result (passthrough): outcome drives the per-master
  // link status (SYNCED / FAILED / NEEDS_REVIEW); evidence fields are
  // stored verbatim for the dashboard and audit trail.
  result: z
    .object({
      outcome: z.enum(["synced", "linked", "failed", "needs_review"]).optional(),
      tallyName: z.string().trim().max(200).optional(),
      tallyMasterId: z.string().trim().max(200).optional(),
      error: z.string().trim().max(1000).optional(),
      match: z.record(z.string(), z.unknown()).optional(),
      fieldDiff: z.array(z.record(z.string(), z.unknown())).optional(),
      requestPayload: z.unknown().optional(),
      responsePayload: z.unknown().optional(),
      retryCount: z.number().int().min(0).max(1000).optional(),
    })
    .passthrough()
    .optional(),
});

// ---------------------------------------------------------------------------
// Phase 3: WhizUnik → Tally master sync (customers, suppliers, SKUs)
// ---------------------------------------------------------------------------

/** GSTIN: 2-digit state + 10-char PAN + entity code + 'Z' + checksum. */
export const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

/** PAN: 5 letters + 4 digits + 1 letter. */
export const PAN_REGEX = /^[A-Z]{5}\d{4}[A-Z]$/;

/** GST rates Tally accepts for stock items in Phase 3. */
export const VALID_GST_RATES = [0, 5, 12, 18, 28] as const;

export const MASTER_KINDS = ["customer", "supplier", "sku"] as const;

// Empty strings from the DB/client mean "not provided" — normalize to
// undefined before validation so optional fields accept "", null and missing.
// GSTIN itself is optional: B2C / unregistered dealers have no GSTIN and
// Tally accepts ledgers without one (only validated when present).
const emptyToUndef = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const masterPartyFields = {
  name: z.string().trim().min(1).max(200),
  gstin: z.preprocess(
    emptyToUndef,
    z.string().trim().toUpperCase().regex(GSTIN_REGEX, "gstin must be a valid 15-character GSTIN").nullish()
  ),
  pan: z.preprocess(
    emptyToUndef,
    z.string().trim().toUpperCase().regex(PAN_REGEX, "pan must match ABCDE1234F").nullish()
  ),
  address: z.preprocess(emptyToUndef, z.string().trim().max(500).nullish()),
  state: z.preprocess(emptyToUndef, z.string().trim().max(100).nullish()),
  pin: z.preprocess(emptyToUndef, z.string().trim().max(20).nullish()),
  phone: z.preprocess(emptyToUndef, z.string().trim().max(40).nullish()),
  email: z.preprocess(
    emptyToUndef,
    z.string().trim().email("email must be a valid email address").max(200).nullish()
  ),
  paymentTerms: z.preprocess(emptyToUndef, z.string().trim().max(200).nullish()),
};

export const wzMasterCustomerSchema = z.object({ ...masterPartyFields });

export const wzMasterSupplierSchema = z.object({ ...masterPartyFields });

export const wzMasterSkuSchema = z.object({
  skuCode: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  hsn: z.preprocess(
    emptyToUndef,
    z.string().trim().regex(/^\d{4,8}$/, "hsn must be 4–8 digits").nullish()
  ),
  gstRate: z.number().refine((n) => (VALID_GST_RATES as readonly number[]).includes(n), {
    message: `gstRate must be one of ${VALID_GST_RATES.join(", ")}`,
  }),
  unit: z.string().trim().min(1).max(40),
  category: z.string().trim().max(200).nullish(),
});

export const wzMasterItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("customer"),
    id: z.string().trim().min(1).max(128),
    version: z.number().int().positive().max(1_000_000_000).optional().default(1),
    fields: wzMasterCustomerSchema,
  }),
  z.object({
    kind: z.literal("supplier"),
    id: z.string().trim().min(1).max(128),
    version: z.number().int().positive().max(1_000_000_000).optional().default(1),
    fields: wzMasterSupplierSchema,
  }),
  z.object({
    kind: z.literal("sku"),
    id: z.string().trim().min(1).max(128),
    version: z.number().int().positive().max(1_000_000_000).optional().default(1),
    fields: wzMasterSkuSchema,
  }),
]);

/** Idempotency key: customer:{id}:{version} | supplier:{id}:{version} | sku:{id}:{version} */
export function masterIdempotencyKey(kind: string, id: string, version: number): string {
  return `${kind}:${id}:${version}`;
}

// Platform: POST /api/integrations/tally/masters/push (JWT) — queue masters
// for the connector, one PUSH_MASTERS command per item (spec §6: one at a time).
// The request carries kind + WhizUnik id only; the server loads and validates
// the Phase 3 fields from the tenant's own tables (record lineage guaranteed).
export const wzPushMastersSchema = z.object({
  connectorId: z.string().trim().min(1).max(120),
  companyId: z.string().trim().min(1).max(128),
  items: z
    .array(
      z.object({
        kind: z.enum(MASTER_KINDS),
        id: z.string().trim().min(1).max(128),
      })
    )
    .min(1)
    .max(100),
});

// Platform: GET /api/integrations/tally/masters/status (JWT) — per-master state.
export const wzMasterStatusQuerySchema = z.object({
  kind: z.enum(MASTER_KINDS).optional(),
  status: z.enum(["NOT_SYNCED", "QUEUED", "SENDING", "SYNCED", "FAILED", "NEEDS_REVIEW"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export function formatWzIssues(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "Invalid request payload";
  const path = first.path.join(".") || "(root)";
  return `${path}: ${first.message}`;
}
