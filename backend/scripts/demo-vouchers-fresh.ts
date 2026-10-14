/**
 * Fresh push-ready demo voucher set (dev only). New numbers each run via
 * SUFFIX env (default 9011) so drafts never clash with earlier demo sets.
 * All Oct-1 dated for the current Tally period. Queues ONE PUSH_VOUCHERS
 * command and prints creds for the connector push script.
 *
 * Usage: npx tsx scripts/demo-vouchers-fresh.ts [SUFFIX=9012]
 */
import "dotenv/config";

const API = process.env.API ?? "http://127.0.0.1:3001";
const EMAIL = process.env.EMAIL ?? "phase4-demo@whizunik.test";
const PASSWORD = process.env.PASSWORD ?? "Demo@12345";
const DATE = process.env.PUSH_DATE ?? "2026-10-01";
const SUFFIX = process.env.SUFFIX ?? "9011";

async function api(path: string, method: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main(): Promise<void> {
  const signin = await api("/api/auth/signin", "POST", { email: EMAIL, password: PASSWORD });
  const token = signin.json.token as string;
  const pc = await api("/api/integrations/tally/admin/pairing-codes", "POST", { tenantName: "Phase4 Demo", companyName: "Whizunik" }, token);
  const connect = await api("/api/integrations/tally/connect", "POST", {
    pairingCode: pc.json.pairingCode,
    deviceId: `demo-fresh-${SUFFIX}-${Date.now()}`,
    deviceName: "DEMO-FRESH",
    appVersion: "1.0.0",
    protocolVersion: "1.0",
    company: { name: "Whizunik", tallyGuid: "demo-fresh" },
  });
  const connectorId = connect.json.connectorId as string;
  const companyId = connect.json.companyMapping.whizunikCompanyId as string;
  const accessToken = connect.json.accessToken as string;

  const N = (p: string): string => `${p}-${SUFFIX}`;
  const drafts = [
    { voucherType: "SALES", voucherNumber: N("SALE"), voucherDate: DATE, partyName: "Demo Customer One", amount: 6600, narration: "Fresh demo sale", counterLedgerName: "Sales Account" },
    { voucherType: "PURCHASE", voucherNumber: N("PUR"), voucherDate: DATE, partyName: "Demo Supplier One", amount: 9200, narration: "Fresh demo purchase", counterLedgerName: "Purchase Ledger" },
    { voucherType: "CREDIT_NOTE", voucherNumber: N("CN"), voucherDate: DATE, partyName: "Demo Customer One", amount: 1200, narration: "Fresh demo credit", counterLedgerName: "Sales Account", originalReference: "DEMO-1001", reason: "Damaged goods" },
    { voucherType: "DEBIT_NOTE", voucherNumber: N("DN"), voucherDate: DATE, partyName: "Demo Supplier One", amount: 700, narration: "Fresh demo debit", counterLedgerName: "Purchase Ledger", originalReference: "PUR-DEMO-1", reason: "Short delivery" },
    { voucherType: "RECEIPT", voucherNumber: N("RCT"), voucherDate: DATE, partyName: "Demo Customer One", amount: 3000, narration: "Fresh demo receipt", counterLedgerName: "Cash", originalReference: "DEMO-1001" },
    { voucherType: "PAYMENT", voucherNumber: N("PMT"), voucherDate: DATE, partyName: "Demo Supplier One", amount: 2500, narration: "Fresh demo payment", counterLedgerName: "Cash", originalReference: "PUR-DEMO-1" },
    { voucherType: "JOURNAL", voucherNumber: N("JRN"), voucherDate: DATE, partyName: "Demo Customer One", amount: 1100, narration: "Fresh demo journal", counterLedgerName: "Sales Account" },
    { voucherType: "CONTRA", voucherNumber: N("CTR"), voucherDate: DATE, partyName: "Cash", amount: 20000, narration: "Fresh demo contra", counterLedgerName: "Demo Bank Account" },
  ] as const;
  const ids: string[] = [];
  for (const d of drafts) {
    const created = await api("/api/integrations/tally/push-data/vouchers", "POST", d, token);
    if (created.status === 201) {
      ids.push(created.json.voucher.id as string);
      console.log(`draft: ${d.voucherType} ${d.voucherNumber} ${d.partyName} ${d.amount}`);
    } else {
      console.log(`skip: ${d.voucherNumber} -> ${created.status} ${JSON.stringify(created.json).slice(0, 140)}`);
    }
  }
  if (!ids.length) return;
  const push = await api("/api/integrations/tally/push-data/vouchers/push", "POST", { connectorId, companyId, voucherIds: ids }, token);
  if (push.status !== 201) throw new Error(`queue failed: ${JSON.stringify(push.json)}`);
  console.log(`queued: command ${push.json.id} (${push.json.voucherCount})`);
  console.log(`CONNECTOR_ID=${connectorId}`);
  console.log(`ACCESS_TOKEN=${accessToken}`);
  console.log(`COMMAND_ID=${push.json.id}`);
}

main().catch((err) => {
  console.error("failed:", err);
  process.exit(1);
});
