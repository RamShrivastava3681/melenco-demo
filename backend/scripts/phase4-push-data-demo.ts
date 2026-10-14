/**
 * Create push-ready Tally voucher drafts on the platform (dev table only).
 *
 * These are AMOUNT-ONLY Sales drafts — the shape proven to post on the live
 * TallyPrime (inventory lines are blocked there until the item/stock setup
 * is resolved). Dates use the 1st of the month (EDU Tally restriction).
 *
 * Usage:
 *   npx tsx scripts/phase4-push-data-demo.ts
 *
 * Env:
 *   API, EMAIL, PASSWORD (defaults to the Phase 4 demo account)
 *   CONNECTOR_ID, COMPANY_ID (defaults to the live "Whizunik" pairing)
 *   PUSH_DATE (default 2026-10-01)
 */
import "dotenv/config";

const API = process.env.API ?? "http://127.0.0.1:3001";
const EMAIL = process.env.EMAIL ?? "phase4-demo@whizunik.test";
const PASSWORD = process.env.PASSWORD ?? "Demo@12345";
const CONNECTOR_ID = process.env.CONNECTOR_ID ?? "wz-connector-e9ff8ed6";
const COMPANY_ID = process.env.COMPANY_ID ?? "whiz-company-7919cb";
const PUSH_DATE = process.env.PUSH_DATE ?? "2026-10-01";

async function api(path: string, method: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main(): Promise<void> {
  const signin = await api("/api/auth/signin", "POST", { email: EMAIL, password: PASSWORD });
  if (signin.status !== 200) throw new Error(`signin failed: ${JSON.stringify(signin.json)}`);
  const token = signin.json.token as string;

  // Amount-only Sales drafts against ledgers that exist in Tally.
  const drafts = [
    { voucherType: "SALES", voucherNumber: "PUSH-9001", voucherDate: PUSH_DATE, partyName: "Demo Customer One", amount: 7500, narration: "Services Oct — amount-only demo 1" },
    { voucherType: "SALES", voucherNumber: "PUSH-9002", voucherDate: PUSH_DATE, partyName: "Demo Customer Two", amount: 3200, narration: "Services Oct — amount-only demo 2" },
    { voucherType: "SALES", voucherNumber: "PUSH-9003", voucherDate: PUSH_DATE, partyName: "Phase4 Customer", amount: 999, narration: "Services Oct — amount-only demo 3" },
    { voucherType: "SALES", voucherNumber: "PUSH-9004", voucherDate: PUSH_DATE, partyName: "Demo Customer One", amount: 15000, narration: "Services Oct — amount-only demo 4" },
    { voucherType: "SALES", voucherNumber: "PUSH-9005", voucherDate: PUSH_DATE, partyName: "Demo Customer Two", amount: 450, narration: "Services Oct — amount-only demo 5" },
  ] as const;

  const ids: string[] = [];
  for (const d of drafts) {
    const created = await api("/api/integrations/tally/push-data/vouchers", "POST", d, token);
    if (created.status === 201) {
      ids.push(created.json.voucher.id as string);
      console.log(`draft: ${d.voucherNumber} (${d.partyName} ${d.amount})`);
    } else {
      console.log(`skip: ${d.voucherNumber} -> ${created.status} ${JSON.stringify(created.json).slice(0, 160)}`);
    }
  }
  if (ids.length === 0) {
    console.log("nothing new to queue (drafts already exist — delete or push them first)");
    return;
  }

  const push = await api("/api/integrations/tally/push-data/vouchers/push", "POST", { connectorId: CONNECTOR_ID, companyId: COMPANY_ID, voucherIds: ids }, token);
  if (push.status !== 201) throw new Error(`queue failed: ${JSON.stringify(push.json)}`);
  console.log(`queued: command ${push.json.id} with ${push.json.voucherCount} voucher(s)`);
  console.log(`COMMAND_ID=${push.json.id}`);
}

main().catch((err) => {
  console.error("Draft setup failed:", err);
  process.exit(1);
});
