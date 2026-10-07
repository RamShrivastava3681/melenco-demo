/** Single-table key builders. Table = process.env.DYNAMODB_TABLE_PREFIX. */

export function nowIso(): string {
  return new Date().toISOString();
}

// --- User scope ---
export const userPk = (userId: string): string => `USER#${userId}`;
export const userSk = (userId: string): string => `USER#${userId}`;

export const customerSk = (id: string): string => `CUSTOMER#${id}`;
export const supplierSk = (id: string): string => `SUPPLIER#${id}`;
export const productSk = (id: string): string => `PRODUCT#${id}`;
export const invoiceSk = (id: string): string => `INVOICE#${id}`;
export const paymentSk = (id: string): string => `PAYMENT#${id}`;
export const allocSk = (id: string): string => `ALLOC#${id}`;
export const XERO_SK = "XERO#CONNECTION";

export const companySk = (id: string): string => `COMPANY#${id}`;
export const connectorSk = (id: string): string => `CONNECTOR#${id}`;
export const pairingSk = (id: string): string => `PAIRING#${id}`;
export const sessionSk = (syncId: string): string => `SESSION#${syncId}`;
export const batchSk = (sessionRowId: string, batchNumber: number): string =>
  `BATCH#${sessionRowId}#${batchNumber}`;
export const sourceSk = (entityType: string, objectId: string): string =>
  `SOURCE#${entityType}#${objectId}`;
export const rawSk = (id: string): string => `RAW#${id}`;
export const checkpointSk = (companyId: string, entityType: string): string =>
  `CHECKPOINT#${companyId}#${entityType}`;
export const auditSk = (createdAt: string, id: string): string => `AUDIT#${createdAt}#${id}`;
export const ledgerSk = (id: string): string => `LEDGER#${id}`;
export const purchaseInvoiceSk = (id: string): string => `PINVOICE#${id}`;
export const voucherSk = (id: string): string => `VOUCHER#${id}`;
export const reportSk = (companyId: string, reportType: string, reportDate: string): string =>
  `REPORT#${companyId}#${reportType}#${reportDate}`;
export const commandSk = (id: string): string => `COMMAND#${id}`;

// --- Tenant (whizunik) scope ---
export const tenantPk = (tenantId: string): string => `TENANT#${tenantId}`;
export const tenantSk = (tenantId: string): string => `TENANT#${tenantId}`;

export const wConnectorSk = (id: string): string => `WCONNECTOR#${id}`;
export const wCompanySk = (id: string): string => `WCOMPANY#${id}`;
export const wBatchSk = (batchId: string): string => `WSYNCBATCH#${batchId}`;
export const wPairingSk = (code: string): string => `WPAIRING#${code}`;
export const wRecordSk = (id: string): string => `WSYNCRECORD#${id}`;
export const wCommandSk = (id: string): string => `WCOMMAND#${id}`;
export const mLinkSk = (kind: string, whizunikId: string): string =>
  `MSYNCLINK#${kind}#${whizunikId}`;
export const mAttemptSk = (id: string): string => `MSYNCATTEMPT#${id}`;
