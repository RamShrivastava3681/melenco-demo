import { z } from "zod";
import { ALL_ENTITY_TYPES, SYNC_TYPES } from "../constants.js";

/**
 * Payload validation schemas (zod).
 * Reused by routes (HTTP envelope) and normalizers (per-record structure).
 */

const entityTypeSchema = z.enum(ALL_ENTITY_TYPES as unknown as [string, ...string[]]);
const syncTypeSchema = z.enum(SYNC_TYPES as unknown as [string, ...string[]]);

export const pairingCodeRequestSchema = z.object({
  connectorName: z.string().trim().min(1).max(60).optional(),
});

export const connectRequestSchema = z.object({
  pairingCode: z.string().trim().regex(/^WZK-[A-Z0-9]{4}-[A-Z0-9]{4}$/, "Format: WZK-XXXX-XXXX"),
  connectorName: z.string().trim().min(1).max(60).optional(),
  deviceName: z.string().trim().min(1).max(120).optional(),
  deviceId: z.string().trim().min(1).max(120).optional(),
  appVersion: z.string().trim().min(1).max(40).optional(),
  companies: z
    .array(
      z.object({
        guid: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(200),
      })
    )
    .max(50)
    .optional(),
});

export const heartbeatRequestSchema = z.object({
  appVersion: z.string().trim().max(40).optional(),
  pendingUploads: z.number().int().nonnegative().optional(),
});

export const syncStartRequestSchema = z.object({
  companyId: z.string().trim().min(1).max(64),
  entityType: entityTypeSchema,
  syncType: syncTypeSchema,
  totalRecords: z.number().int().nonnegative().max(10_000_000).optional(),
  totalBatches: z.number().int().nonnegative().max(1_000_000).optional(),
});

export const batchRecordSchema = z
  .object({
    sourceObjectId: z.string().trim().min(1).max(200).optional(),
    tallyGuid: z.string().trim().max(200).optional(),
    voucherType: z.string().trim().max(100).nullish(),
    voucherNumber: z.string().trim().max(100).nullish(),
    voucherDate: z.string().trim().max(30).nullish(),
    partyName: z.string().trim().max(300).nullish(),
    amount: z.number().finite().nullish(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const batchRequestSchema = z.object({
  syncId: z.string().trim().min(4).max(64),
  companyId: z.string().trim().min(1).max(64),
  entityType: entityTypeSchema,
  batchNumber: z.number().int().positive().max(1_000_000),
  totalBatches: z.number().int().positive().max(1_000_000),
  records: z.array(batchRecordSchema).min(1).max(5_000),
});

export const syncCompleteRequestSchema = z.object({
  syncId: z.string().trim().min(4).max(64),
  lastObjectId: z.string().trim().max(200).nullish(),
  lastVoucherDate: z.string().trim().max(30).nullish(),
  lastVoucherNumber: z.string().trim().max(100).nullish(),
});

export const syncErrorRequestSchema = z.object({
  syncId: z.string().trim().min(4).max(64),
  errorMessage: z.string().trim().min(1).max(2000),
  recoverable: z.boolean().optional(),
});

// Aliases used by the connector routes
export const connectSchema = connectRequestSchema;
export const heartbeatSchema = heartbeatRequestSchema;
export const syncStartSchema = syncStartRequestSchema;
export const batchSchema = batchRequestSchema;
export const syncCompleteSchema = syncCompleteRequestSchema;
export const syncErrorSchema = syncErrorRequestSchema;

export const commandAckSchema = z.object({
  commandId: z.string().trim().min(1).max(128),
  status: z.enum(["DONE", "CANCELLED"]),
});

export function formatZodError(err: z.ZodError): { issues: Array<{ path: string; message: string }> } {
  return {
    issues: err.issues.map((i) => ({
      path: i.path.join(".") || "(root)",
      message: i.message,
    })),
  };
}
