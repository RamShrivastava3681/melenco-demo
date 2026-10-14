import { writeAudit } from "../../../db/storesTally.js";

/** Audit events recorded for compliance/traceability. */
export type AuditEvent =
  | "PAIRING_CODE_CREATED"
  | "PAIRING_CODE_EXPIRED"
  | "CONNECTOR_CONNECTED"
  | "CONNECTOR_DISCONNECTED"
  | "CONNECTOR_REVOKED"
  | "CONNECTOR_REVOKED_BY_REPAIRED"
  | "COMPANY_MAPPED"
  | "SYNC_STARTED"
  | "SYNC_COMPLETED"
  | "SYNC_PARTIAL"
  | "SYNC_FAILED"
  | "SYNC_CANCELLED"
  | "BATCH_ACCEPTED"
  | "BATCH_REJECTED"
  | "BATCH_REPLAYED"
  | "AUTHENTICATION_FAILED"
  | "AUTHORIZATION_FAILED"
  | "RATE_LIMITED"
  | "RAW_RECORDS_PURGED"
  | "IRN_PREFLIGHT_STARTED"
  | "IRN_PREFLIGHT_PASSED"
  | "IRN_PREFLIGHT_FAILED"
  | "IRN_REQUEST_CREATED"
  | "IRN_SUBMITTED"
  | "IRN_RESPONSE_RECEIVED"
  | "IRN_GENERATED"
  | "IRN_REJECTED"
  | "IRN_RETRYABLE_FAILURE"
  | "IRN_RESULT_STORED"
  | "EWB_PREFLIGHT_STARTED"
  | "EWB_PREFLIGHT_PASSED"
  | "EWB_PREFLIGHT_FAILED"
  | "EWB_REQUEST_CREATED"
  | "EWB_SUBMITTED"
  | "EWB_RESPONSE_RECEIVED"
  | "EWB_GENERATED"
  | "EWB_REJECTED"
  | "EWB_RETRYABLE_FAILURE"
  | "EWB_RESULT_STORED"
  | "DISPATCH_RELEASED"
  | "INVENTORY_DEDUCTED";

export interface AuditContext {
  userId: string;
  connectorId?: string | null;
  syncId?: string | null;
  requestId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Write an audit event. Never throws — audit failures must not break the
 * request path. Detail payloads must already be sanitized (no financial data).
 * Fire-and-forget: returns void so existing sync call sites keep working.
 */
export function audit(event: AuditEvent, ctx: AuditContext): void {
  void writeAudit({
    userId: ctx.userId,
    connectorId: ctx.connectorId,
    syncId: ctx.syncId,
    event,
    requestId: ctx.requestId,
    detail: ctx.detail,
  });
}
