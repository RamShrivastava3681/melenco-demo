/** Sales/purchase/journal/contra Oct demos under a fresh connector (dev only). */
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
    deviceId: `demo-oct2-${Date.now()}`,
    deviceName: "DEMO-OCT2",
    appVersion: "1.0.0",
    protocolVersion: "1.0",
    company: { name: "Whizunik", tallyGuid: "demo-oct2" },
  });
  const connectorId = connect.json.connectorId as string;
  const companyId = connect.json.companyMapping.whizunikCompanyId as string;
  const accessToken = connect.json.accessToken as string;

  const drafts = [
    { voucherType: "SALES", voucherNumber: "SALE-9001", voucherDate: DATE, partyName: "Demo Customer Two", amount: 6600, narration: "Demo sale Oct" },
    { voucherType: "PURCHASE", voucherNumber: "PUR-9001", voucherDate: DATE, partyName: "Demo Supplier One", amount: 9200, narration: "Demo purchase Oct", counterLedgerName: "Purchase Ledger" },
    { voucherType: "JOURNAL", voucherNumber: "JRN-9001", voucherDate: DATE, partyName: "Demo Customer One", amount: 1100, narration: "Demo journal Oct", counterLedgerName: "Sales Account" },
    { voucherType: "CONTRA", voucherNumber: "CTR-9001", voucherDate: DATE, partyName: "Cash", amount: 20000, narration: "Demo contra Oct", counterLedgerName: "Demo Bank Account" },
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
