/**
 * Seed EVERY master + voucher type on the cloud for manual push testing
 * (dev table only — DUMMY DATA).
 *
 * Masters: customers (exist), 1 supplier (Demo Supplier One), 4 SKUs.
 * Voucher drafts (all dated PUSH_DATE, default 2026-04-01 for the EDU Tally):
 *   SALES, PURCHASE, CREDIT_NOTE, DEBIT_NOTE, RECEIPT, PAYMENT, JOURNAL, CONTRA
 * Queues them as ONE PUSH_VOUCHERS command for a fresh connector and prints
 * the creds so tools/push-one-invoice.ts (or a paired desktop connector)
 * can push them.
 *
 * Usage: npx tsx scripts/phase4-all-types-seed.ts
 * Env: API, EMAIL, PASSWORD, PUSH_DATE (default 2026-04-01)
 */
import "dotenv/config";
import { initializeDatabase } from "../src/db/index.js";
import { getUserByEmail } from "../src/db/storesCore.js";
import { findSupplierByName, createSupplier, findProductByName, createProduct } from "../src/db/storesCore.js";

const API = process.env.API ?? "http://127.0.0.1:3001";
const EMAIL = process.env.EMAIL ?? "phase4-demo@whizunik.test";
const PASSWORD = process.env.PASSWORD ?? "Demo@12345";
const PUSH_DATE = process.env.PUSH_DATE ?? "2026-04-01";

async function api(path: string, method: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main(): Promise<void> {
  await initializeDatabase();
  const user = await getUserByEmail(EMAIL);
  if (!user) throw new Error(`no such user ${EMAIL}`);
  const userId = user.id as string;

  // --- Masters (every type) ---
  if (!(await findSupplierByName(userId, "Demo Supplier One"))) {
    await createSupplier(userId, "Demo Supplier One");
    console.log("supplier: created Demo Supplier One");
  } else {
    console.log("supplier: exists Demo Supplier One");
  }
  const skus = [
    { name: "Demo Widget A", sku_code: "Demo Widget A", base_unit: "Nos", gst_rate: 18, group_name: "Demo Goods" },
    { name: "Demo Widget B", sku_code: "Demo Widget B", base_unit: "Box", gst_rate: 12, group_name: "Demo Goods" },
    { name: "Demo Widget C", sku_code: "Demo Widget C", base_unit: "Kg", gst_rate: 5, group_name: "Demo Goods" },
    { name: "Phase4 Widget", sku_code: "Phase4 Widget", base_unit: "Nos", gst_rate: 18, group_name: "Phase4 Goods" },
  ];
  for (const s of skus) {
    if (!(await findProductByName(userId, s.name))) {
      await createProduct(userId, s);
      console.log(`sku: created ${s.name}`);
    } else {
      console.log(`sku: exists ${s.name}`);
    }
  }

  // --- Auth + fresh connector ---
  const signin = await api("/api/auth/signin", "POST", { email: EMAIL, password: PASSWORD });
  const token = signin.json.token as string;
  const pc = await api("/api/integrations/tally/admin/pairing-codes", "POST", { tenantName: "Phase4 Demo", companyName: "Whizunik" }, token);
  const connect = await api("/api/integrations/tally/connect", "POST", {
    pairingCode: pc.json.pairingCode,
    deviceId: `demo-alltypes-${Date.now()}`,
    deviceName: "DEMO-ALLTYPES",
    appVersion: "1.0.0",
    protocolVersion: "1.0",
    company: { name: "Whizunik", tallyGuid: "demo-alltypes" },
  });
  const connectorId = connect.json.connectorId as string;
  const companyId = connect.json.companyMapping.whizunikCompanyId as string;
  const accessToken = connect.json.accessToken as string;
  console.log(`connector: ${connectorId} company: ${companyId}`);

  // --- One draft per voucher type (Apr-1, proven Tally ledgers) ---
  // Counters are explicit (no reliance on defaults except receipt/payment).
  const drafts = [
    { voucherType: "SALES", voucherNumber: "ALL-SALE", voucherDate: PUSH_DATE, partyName: "Demo Customer One", amount: 5000, narration: "All-types demo sale" },
    { voucherType: "PURCHASE", voucherNumber: "ALL-PUR", voucherDate: PUSH_DATE, partyName: "Demo Supplier One", amount: 8000, narration: "All-types demo purchase", counterLedgerName: "Purchase Ledger" },
    { voucherType: "CREDIT_NOTE", voucherNumber: "ALL-CN", voucherDate: PUSH_DATE, partyName: "Demo Customer One", amount: 1200, narration: "All-types demo credit", counterLedgerName: "Sales Account", originalReference: "DEMO-1001", reason: "Damaged goods" },
    { voucherType: "DEBIT_NOTE", voucherNumber: "ALL-DN", voucherDate: PUSH_DATE, partyName: "Demo Supplier One", amount: 700, narration: "All-types demo debit", counterLedgerName: "Purchase Ledger", originalReference: "PUR-DEMO-1", reason: "Short delivery" },
    { voucherType: "RECEIPT", voucherNumber: "ALL-RCT", voucherDate: PUSH_DATE, partyName: "Demo Customer One", amount: 3000, narration: "All-types demo receipt", counterLedgerName: "Cash" },
    { voucherType: "PAYMENT", voucherNumber: "ALL-PMT", voucherDate: PUSH_DATE, partyName: "Demo Supplier One", amount: 2500, narration: "All-types demo payment", counterLedgerName: "Cash" },
    { voucherType: "JOURNAL", voucherNumber: "ALL-JRN", voucherDate: PUSH_DATE, partyName: "Demo Customer One", amount: 400, narration: "All-types demo journal", counterLedgerName: "Sales Account" },
    { voucherType: "CONTRA", voucherNumber: "ALL-CTR", voucherDate: PUSH_DATE, partyName: "Cash", amount: 10000, narration: "All-types demo contra to bank", counterLedgerName: "Demo Bank Account" },
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
  if (ids.length === 0) {
    console.log("nothing new to queue");
    return;
  }

  // NOTE: push-data drafts carry only party/amount — the connector applies
  // per-type counter ledgers. Journal/contra drafts need explicit counters,
  // which the queue payload below injects per draft.
  const push = await api("/api/integrations/tally/push-data/vouchers/push", "POST", { connectorId, companyId, voucherIds: ids }, token);
  if (push.status !== 201) throw new Error(`queue failed: ${JSON.stringify(push.json)}`);
  console.log(`queued: command ${push.json.id} with ${push.json.voucherCount} voucher(s)`);
  console.log(`CONNECTOR_ID=${connectorId}`);
  console.log(`COMPANY_ID=${companyId}`);
  console.log(`ACCESS_TOKEN=${accessToken}`);
  console.log(`COMMAND_ID=${push.json.id}`);
}

main().catch((err) => {
  console.error("All-types seed failed:", err);
  process.exit(1);
});
