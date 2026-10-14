/**
 * One-command IRN demo: creates test invoices that look uploaded in Tally
 * (status COMPLETED with Tally voucher number + reference) and generates
 * an IRN for each of them through the mock IRP.
 *
 * Usage:
 *   node scripts/irn-demo.mjs                                   # localhost:3001
 *   BASE_URL=https://excel.frillchills.com/api node scripts/irn-demo.mjs
 *   DEMO_EMAIL=you@example.com DEMO_PASSWORD=secret node scripts/irn-demo.mjs
 *
 * Exit code 0 only when every seeded invoice reaches IRN_GENERATED.
 */
const BASE_URL = (process.env.BASE_URL || "http://localhost:3001/api").replace(/\/$/, "");
const EMAIL = process.env.DEMO_EMAIL || "irn-demo@example.com";
const PASSWORD = process.env.DEMO_PASSWORD || "password123";

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function main() {
  console.log(`IRN demo → ${BASE_URL}`);

  // 1. Sign up (or sign in when the demo user already exists).
  let token = null;
  const signup = await call("/auth/signup", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD, name: "IRN Demo" },
  });
  if (signup.status === 201) {
    token = signup.json.token;
    console.log(`Signed up ${EMAIL}`);
  } else if (signup.status === 409) {
    const signin = await call("/auth/signin", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    if (signin.status !== 200 || !signin.json?.token) {
      throw new Error(`Signin failed: HTTP ${signin.status} ${JSON.stringify(signin.json)}`);
    }
    token = signin.json.token;
    console.log(`Signed in ${EMAIL} (existing user)`);
  } else {
    throw new Error(`Signup failed: HTTP ${signup.status} ${JSON.stringify(signup.json)}`);
  }

  // 2. Seed Tally-posted demo invoices (idempotent — safe to re-run).
  const seed = await call("/integrations/tally/irn/seed", { method: "POST", token, body: {} });
  if (seed.status !== 201) {
    throw new Error(`Seed failed: HTTP ${seed.status} ${JSON.stringify(seed.json)}`);
  }
  console.log(`Seed: ${seed.json.created} created, ${seed.json.skipped} already existed`);
  const invoices = seed.json.invoices ?? [];
  if (invoices.length === 0) throw new Error("Seed returned no invoices");

  // 3. Request an IRN for each invoice (no compliance needed — seeded).
  let failed = 0;
  for (const inv of invoices) {
    const res = await call("/integrations/tally/irn/request", {
      method: "POST",
      token,
      body: { invoiceId: inv.id },
    });
    const ok = res.json?.irnStatus === "IRN_GENERATED" && res.json?.irn;
    if (!ok) failed++;
    console.log(
      `${ok ? "OK  " : "FAIL"} ${inv.invoice_number}  Tally voucher ${inv.tally_voucher_number}  ` +
        `ref ${inv.tally_reference}  → ${res.json?.irnStatus ?? `HTTP ${res.status}`}  ` +
        `IRN ${res.json?.irn ?? "-"}  Ack ${res.json?.acknowledgementNumber ?? "-"}` +
        `${res.json?.duplicate ? " (duplicate, reused)" : ""}` +
        (res.json?.missingField ? `  missing: ${res.json.missingField}` : "")
    );
  }

  if (failed > 0) {
    console.error(`\n${failed} invoice(s) did NOT reach IRN_GENERATED (mock IRN — test result only, not a legal IRN).`);
    process.exit(1);
  }
  console.log(`\nAll ${invoices.length} invoice(s) IRN_GENERATED (mock IRN — test result only, not a legal IRN).`);
}

main().catch((err) => {
  console.error(`Demo failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
