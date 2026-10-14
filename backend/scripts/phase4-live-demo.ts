/**
 * Phase 4 LIVE demo setup (dev table only — DUMMY DATA).
 *
 * Signs up (or signs in) a demo user, creates demo customers + demo
 * invoices, pairs a demo connector, and queues ONE invoice (PH4-0001) as
 * PUSH_VOUCHERS. The rest stay OPEN so you can push them from the cloud.
 *
 * The Tally company name matches the (mock) TallyPrime company so the
 * connector's company check passes: use "ABC Traders" with the mock
 * tally server, or your real Tally company name against real TallyPrime.
 *
 * Usage:
 *   npx tsx scripts/phase4-live-demo.ts [--push-all]
 *     --push-all  queue ALL demo invoices, not just PH4-0001
 *
 * Env:
 *   API   base URL (default http://127.0.0.1:3001)
 *   EMAIL / PASSWORD (default phase4-demo@whizunik.test / Demo@12345)
 *   COMPANY_NAME (default "ABC Traders")
 */
import "dotenv/config";

const API = process.env.API ?? "http://127.0.0.1:3001";
const EMAIL = process.env.EMAIL ?? "phase4-demo@whizunik.test";
const PASSWORD = process.env.PASSWORD ?? "Demo@12345";
const COMPANY_NAME = process.env.COMPANY_NAME ?? "ABC Traders";
const PUSH_ALL = process.argv.includes("--push-all");

async function api(path: string, method: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function main(): Promise<void> {
  // 1. Auth (signup, fall back to signin).
  let token = "";
  let userId = "";
  const signup = await api("/api/auth/signup", "POST", { email: EMAIL, password: PASSWORD, name: "Phase4 Demo" });
  if (signup.status === 201) {
    token = signup.json.token;
    userId = signup.json.user.id;
    console.log(`user: signed up ${EMAIL} (${userId})`);
  } else {
    const signin = await api("/api/auth/signin", "POST", { email: EMAIL, password: PASSWORD });
    if (signin.status !== 200) throw new Error(`auth failed: ${JSON.stringify(signin.json)}`);
    token = signin.json.token;
    userId = signin.json.user.id;
    console.log(`user: signed in ${EMAIL} (${userId})`);
  }

  // 2. Demo customers (idempotent by name).
  const customerNames = ["Demo Customer One", "Demo Customer Two", "Phase4 Customer"];
  const customerIds = new Map<string, string>();
  const existingCustomers = await api("/api/customers", "GET", undefined, token);
  for (const name of customerNames) {
    const found = (existingCustomers.json?.customers ?? []).find((c: any) => c.name === name);
    if (found) {
      customerIds.set(name, found.id);
      console.log(`customer: exists "${name}" (${found.id})`);
      continue;
    }
    const created = await api("/api/customers", "POST", { name }, token);
    if (created.status !== 201) throw new Error(`customer create failed: ${JSON.stringify(created.json)}`);
    customerIds.set(name, created.json.customer.id);
    console.log(`customer: created "${name}" (${created.json.customer.id})`);
  }

  // 3. Demo invoices (idempotent by invoice_number).
  const demos = [
    { invoice_number: "PH4-0001", customer: "Phase4 Customer", issue_date: "2026-10-01", due_date: "2026-11-01", amount: 11800, quantity: 10, unit: "Nos", unit_price: 1000, gst_rate: 18, sku_code: "Phase4 Widget", grand_total: 11800 },
    { invoice_number: "DEMO-1001", customer: "Demo Customer One", issue_date: "2026-10-05", due_date: "2026-11-05", amount: 11800, quantity: 5, unit: "Nos", unit_price: 2000, gst_rate: 18, sku_code: "Demo Widget A", grand_total: 11800 },
    { invoice_number: "DEMO-1002", customer: "Demo Customer Two", issue_date: "2026-10-06", due_date: "2026-11-06", amount: 11200, quantity: 2, unit: "Box", unit_price: 5000, gst_rate: 12, sku_code: "Demo Widget B", grand_total: 11200 },
    { invoice_number: "DEMO-1003", customer: "Demo Customer One", issue_date: "2026-10-07", due_date: "2026-11-07", amount: 10500, quantity: 20, unit: "Kg", unit_price: 500, gst_rate: 5, sku_code: "Demo Widget C", grand_total: 10500 },
    { invoice_number: "DEMO-1004", customer: "Demo Customer Two", issue_date: "2026-10-08", due_date: "2026-11-08", amount: 5000, quantity: 5, unit: "Nos", unit_price: 1000, gst_rate: 0, sku_code: "Demo Widget A", grand_total: 5000 },
  ];
  const existingInvoices = await api("/api/invoices", "GET", undefined, token);
  const haveNumbers = new Set((existingInvoices.json?.invoices ?? []).map((i: any) => i.invoice_number));
  const toCreate = demos.filter((d) => !haveNumbers.has(d.invoice_number));
  if (toCreate.length > 0) {
    const created = await api(
      "/api/invoices",
      "POST",
      {
        invoices: toCreate.map((d) => ({
          customer_id: customerIds.get(d.customer)!,
          invoice_number: d.invoice_number,
          issue_date: d.issue_date,
          due_date: d.due_date,
          amount: d.amount,
          quantity: d.quantity,
          unit: d.unit,
          unit_price: d.unit_price,
          gst_rate: d.gst_rate,
          sku_code: d.sku_code,
          grand_total: d.grand_total,
        })),
      },
      token
    );
    if (created.status !== 201) throw new Error(`invoice create failed: ${JSON.stringify(created.json)}`);
    console.log(`invoices: created ${created.json.importedCount}, skipped ${created.json.skippedCount}`);
  } else {
    console.log("invoices: all demo invoices already exist");
  }
  const allInvoices = (await api("/api/invoices", "GET", undefined, token)).json?.invoices ?? [];
  const byNumber = new Map(allInvoices.map((i: any) => [i.invoice_number, i]));

  // 4. Pair + connect a demo connector for this tenant.
  const pc = await api("/api/integrations/tally/admin/pairing-codes", "POST", { tenantName: "Phase4 Demo", companyName: COMPANY_NAME }, token);
  if (pc.status !== 201) throw new Error(`pairing code failed: ${JSON.stringify(pc.json)}`);
  const connect = await api("/api/integrations/tally/connect", "POST", {
    pairingCode: pc.json.pairingCode,
    deviceId: `demo-device-${Date.now()}`,
    deviceName: "DEMO-DESKTOP",
    appVersion: "1.0.0",
    protocolVersion: "1.0",
    company: { name: COMPANY_NAME, tallyGuid: `demo-guid-${Date.now()}` },
  });
  if (connect.status !== 200) throw new Error(`connect failed: ${JSON.stringify(connect.json)}`);
  const connectorId = connect.json.connectorId as string;
  const companyId = connect.json.companyMapping.whizunikCompanyId as string;
  const accessToken = connect.json.accessToken as string;
  console.log(`connector: ${connectorId} company: ${companyId} (${COMPANY_NAME})`);

  // 5. Queue invoices now; the rest stay OPEN for cloud pushing.
  // Env INVOICES overrides the default (comma-separated invoice numbers).
  const pushNumbers = process.env.INVOICES
    ? process.env.INVOICES.split(",").map((s) => s.trim()).filter(Boolean)
    : PUSH_ALL
      ? demos.map((d) => d.invoice_number)
      : ["PH4-0001"];
  const invoiceIds = pushNumbers.map((n) => byNumber.get(n)?.id).filter(Boolean);
  const push = await api("/api/integrations/tally/invoices/push", "POST", { connectorId, companyId, invoiceIds }, token);
  if (push.status !== 201) throw new Error(`push queue failed: ${JSON.stringify(push.json)}`);
  console.log(`queued: command ${push.json.id} with ${push.json.voucherCount} voucher(s): ${pushNumbers.join(", ")}`);

  const open = allInvoices.filter((i: any) => i.status === "open" && !pushNumbers.includes(i.invoice_number));
  console.log(`ready in cloud: ${open.map((i: any) => i.invoice_number).join(", ") || "(none — all queued)"}`);

  console.log("\n--- connector push script env ---");
  console.log(`CLOUD_BASE=${API}`);
  console.log(`CONNECTOR_ID=${connectorId}`);
  console.log(`ACCESS_TOKEN=${accessToken}`);
  console.log(`COMPANY_ID=${companyId}`);
  console.log(`COMMAND_ID=${push.json.id}`);
}

main().catch((err) => {
  console.error("Demo setup failed:", err);
  process.exit(1);
});
