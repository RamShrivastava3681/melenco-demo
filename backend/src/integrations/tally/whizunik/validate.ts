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
    tallyGuid: z.string().trim().max(200).optional(),
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
    sourceCompanyId: z.string().trim().max(200).optional(),
    entityType: z.string().trim().min(1).max(64),
    sourceObjectId: z.string().trim().max(200).optional(),
    sourceVoucherNumber: z.string().trim().max(100).optional(),
    sourceVoucherDate: z.string().trim().max(30).optional(),
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
  tallyVersion: z.string().trim().max(80).optional(),
  company: z.string().trim().max(200).optional(),
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
export const WZ_COMMANDS = ["REQUEST_SYNC", "PAUSE_SYNC", "RESUME_SYNC", "UPDATE_CONFIG"] as const;

export const wzPushCommandSchema = z.object({
  connectorId: z.string().trim().min(1).max(120),
  command: z.enum(WZ_COMMANDS),
  payload: z.record(z.string(), z.unknown()).optional(),
});

// Connector ack: POST /api/integrations/tally/commands/ack (Bearer)
export const wzAckCommandSchema = z.object({
  commandId: z.string().trim().min(1).max(128),
  status: z.enum(["DONE", "CANCELLED"]),
});

export function formatWzIssues(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "Invalid request payload";
  const path = first.path.join(".") || "(root)";
  return `${path}: ${first.message}`;
}
