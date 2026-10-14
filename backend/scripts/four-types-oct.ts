/** Oct-1 dated credit/debit/receipt/payment demos under a fresh connector (dev only). */
import "dotenv/config";

const API = process.env.API ?? "http://127.0.0.1:3001";
const EMAIL = process.env.EMAIL ?? "phase4-demo@whizunik.test";
const PASSWORD = process.env.PASSWORD ?? "Demo@12345";
const DATE = "2026-10-01";

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
    deviceId: `demo-oct-push-${Date.now()}`,
    deviceName: "DEMO-OCT",
    appVersion: "1.0.0",
    protocolVersion: "1.0",
    company: { name: "Whizunik", tallyGuid: "demo-oct" },
  });
  const connectorId = connect.json.connectorId as string;
  const companyId = connect.json.companyMapping.whizunikCompanyId as string;
  const accessToken = connect.json.accessToken as string;

  const drafts = [
    { voucherType: "CREDIT_NOTE", voucherNumber: "CN-9001", voucherDate: DATE, partyName: "Demo Customer One", amount: 1200, narration: "Demo credit note Oct", counterLedgerName: "Sales Account", originalReference: "DEMO-1001", reason: "Damaged goods" },
    { voucherType: "DEBIT_NOTE", voucherNumber: "DN-9001", voucherDate: DATE, partyName: "Demo Supplier One", amount: 700, narration: "Demo debit note Oct", counterLedgerName: "Purchase Ledger", originalReference: "PUR-DEMO-1", reason: "Short delivery" },
    { voucherType: "RECEIPT", voucherNumber: "RCT-9001", voucherDate: DATE, partyName: "Demo Customer One", amount: 3000, narration: "Demo receipt Oct", counterLedgerName: "Cash", originalReference: "DEMO-1001" },
    { voucherType: "PAYMENT", voucherNumber: "PMT-9001", voucherDate: DATE, partyName: "Demo Supplier One", amount: 2500, narration: "Demo payment Oct", counterLedgerName: "Cash", originalReference: "PUR-DEMO-1" },
  ] as const;
  const ids: string[] = [];
  for (const d of drafts) {
    const created = await api("/api/integrations/tally/push-data/vouchers", "POST", d, token);
    if (created.status === 201) {
      ids.push(created.json.voucher.id as string);
      console.log(`draft: ${d.voucherType} ${d.voucherNumber}`);
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
