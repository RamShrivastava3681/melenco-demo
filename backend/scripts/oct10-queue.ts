/** Create + queue an Oct-10 dated draft under the fresh connector (dev only). */
const API = "http://127.0.0.1:3001";
const CONNECTOR_ID = process.env.CONNECTOR_ID ?? "";
const COMPANY_ID = process.env.COMPANY_ID ?? "";

async function main(): Promise<void> {
  const signinRes = await fetch(`${API}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "phase4-demo@whizunik.test", password: "Demo@12345" }),
  });
  const signin = (await signinRes.json()) as { token: string };
  const H = { Authorization: `Bearer ${signin.token}`, "Content-Type": "application/json" };

  const dRes = await fetch(`${API}/api/integrations/tally/push-data/vouchers`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      voucherType: "SALES",
      voucherNumber: "PUSH-OCT10B",
      voucherDate: "2026-10-10",
      partyName: "Demo Customer One",
      amount: 7777,
      narration: "Oct-10 date probe — amount-only",
    }),
  });
  const d = (await dRes.json()) as { voucher?: { id: string } };
  if (dRes.status !== 201 || !d.voucher) throw new Error(`draft failed: ${dRes.status} ${JSON.stringify(d).slice(0, 200)}`);

  const pRes = await fetch(`${API}/api/integrations/tally/push-data/vouchers/push`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ connectorId: CONNECTOR_ID, companyId: COMPANY_ID, voucherIds: [d.voucher.id] }),
  });
  const p = (await pRes.json()) as { id: string };
  if (pRes.status !== 201) throw new Error(`queue failed: ${pRes.status} ${JSON.stringify(p).slice(0, 200)}`);
  console.log(`COMMAND_ID=${p.id}`);
}

main().catch((err) => {
  console.error("queue failed:", err);
  process.exit(1);
});
