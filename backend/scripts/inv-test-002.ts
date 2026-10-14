/** Create + queue the INV-TEST-002 sales draft (Oct-1, Demo Customer Two). */
import "dotenv/config";

const API = process.env.API ?? "http://127.0.0.1:3001";

async function api(path: string, method: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main(): Promise<void> {
  const signin = await api("/api/auth/signin", "POST", { email: "phase4-demo@whizunik.test", password: "Demo@12345" });
  const token = signin.json.token as string;
  const pc = await api("/api/integrations/tally/admin/pairing-codes", "POST", { tenantName: "Phase4 Demo", companyName: "Whizunik" }, token);
  const connect = await api("/api/integrations/tally/connect", "POST", {
    pairingCode: pc.json.pairingCode,
    deviceId: `demo-invtest2-${Date.now()}`,
    deviceName: "DEMO-INVTEST2",
    appVersion: "1.0.0",
    protocolVersion: "1.0",
    company: { name: "Whizunik", tallyGuid: "demo-invtest2" },
  });
  const connectorId = connect.json.connectorId as string;
  const companyId = connect.json.companyMapping.whizunikCompanyId as string;
  const accessToken = connect.json.accessToken as string;

  const created = await api("/api/integrations/tally/push-data/vouchers", "POST", {
    voucherType: "SALES",
    voucherNumber: "INV-TEST-002",
    voucherDate: "2026-10-01",
    partyName: "Demo Customer Two",
    amount: 4242,
    narration: "Visible-reference demo",
  }, token);
  if (created.status !== 201) throw new Error(`draft failed: ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`);
  console.log(`draft: SALES INV-TEST-002 (${created.json.voucher.id})`);

  const push = await api("/api/integrations/tally/push-data/vouchers/push", "POST", { connectorId, companyId, voucherIds: [created.json.voucher.id] }, token);
  if (push.status !== 201) throw new Error(`queue failed: ${JSON.stringify(push.json)}`);
  console.log(`queued: command ${push.json.id}`);
  console.log(`CONNECTOR_ID=${connectorId}`);
  console.log(`ACCESS_TOKEN=${accessToken}`);
  console.log(`COMMAND_ID=${push.json.id}`);
}

main().catch((err) => {
  console.error("failed:", err);
  process.exit(1);
});
