/**
 * Test-customer seeder (DUMMY DATA ONLY).
 *
 * Creates 5 customers for master-sync testing:
 *   - 3 with valid GSTIN (registered dealers)
 *   - 2 with NULL GSTIN (B2C / unregistered — exercises the optional-GSTIN path)
 *
 * Also creates at least 3 demo invoices per customer (15 total):
 *   - 2 open invoices (one overdue, one due soon)
 *   - 1 closed/paid invoice (balance 0, for realistic ageing/payment demos)
 *
 * Usage (with DynamoDB credentials configured):
 *   npx tsx scripts/seed-test-customers.ts <userEmail> [--reset]
 *
 * With --reset, rows named 'Test Customer %' / 'Test B2C Customer %' for the
 * tenant are removed first (customers + their TEST-INV-* invoices) so the
 * script is re-runnable.
 */
import "dotenv/config";
import { initializeDatabase, getUserByEmail, findCustomerByName, createCustomer, findInvoiceByNumber, createInvoice, updateInvoice, listInvoices } from "../src/db/index.js";
import { dbQueryPk, dbDelete } from "../src/db/dynamo.js";
import { userPk } from "../src/db/keys.js";

const CUSTOMERS = [
  {
    name: "Test Customer One",
    invoicePrefix: "TCO",
    gstin: "29ABCDE1234F1Z5",
    pan: "ABCDE1234F",
    address: "42 MG Road, Bengaluru",
    state: "Karnataka",
    pin: "560001",
    phone: "9876543210",
    email: "test.customer.one@example.test",
    payment_terms: "Net 30",
  },
  {
    name: "Test Customer Two",
    invoicePrefix: "TCT",
    gstin: "27ABCDE1234F2Z3",
    pan: "ABCDE1234G",
    address: "7 Linking Road, Mumbai",
    state: "Maharashtra",
    pin: "400001",
    phone: "9123456780",
    email: "test.customer.two@example.test",
    payment_terms: "Net 15",
  },
  {
    name: "Test Customer Three",
    invoicePrefix: "TCTH",
    gstin: "06XYZAB1234C2Z9",
    pan: "XYZAB1234C",
    address: "3 Trader Road, Delhi",
    state: "Delhi",
    pin: "110001",
    phone: "9111122223",
    email: "test.customer.three@example.test",
    payment_terms: "Net 45",
  },
  {
    name: "Test B2C Customer Four",
    invoicePrefix: "TB2C4",
    gstin: null,
    pan: null,
    address: "15 Park Street, Kolkata",
    state: "West Bengal",
    pin: "700001",
    phone: "9333334444",
    email: "test.b2c.four@example.test",
    payment_terms: "Advance",
  },
  {
    name: "Test B2C Customer Five",
    invoicePrefix: "TB2C5",
    gstin: null,
    pan: null,
    address: "8 Beach Road, Chennai",
    state: "Tamil Nadu",
    pin: "600001",
    phone: "9444455556",
    email: "test.b2c.five@example.test",
    payment_terms: "Cash",
  },
];

/** Demo invoice amounts per customer (3 each: 2 open + 1 paid). */
const DEMO_AMOUNTS = [1500.0, 2750.5, 999.99];

function isoDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function dueDate(issueDate: string, addDays: number): string {
  const d = new Date(`${issueDate}T00:00:00Z`);
  d.setDate(d.getDate() + addDays);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const userEmail = process.argv[2];
  const reset = process.argv.includes("--reset");
  if (!userEmail) {
    console.error("Usage: npx tsx scripts/seed-test-customers.ts <userEmail> [--reset]");
    process.exit(1);
  }

  await initializeDatabase();

  const user = await getUserByEmail(userEmail);
  if (!user) {
    console.error(`No such user: ${userEmail}`);
    process.exit(1);
  }

  if (reset) {
    // Remove demo customers and their demo invoices so the script is re-runnable.
    const customers = await dbQueryPk(userPk(user.id), "CUSTOMER#");
    const customerIds = new Set<string>();
    for (const r of customers) {
      const n = String(r.name || "");
      if (n.startsWith("Test Customer ") || n.startsWith("Test B2C Customer ")) {
        customerIds.add(String((r as any).id));
        await dbDelete(r.pk, r.sk);
      }
    }
    const invoices = await dbQueryPk(userPk(user.id), "INVOICE#");
    for (const inv of invoices) {
      const num = String(inv.invoice_number || "");
      const belongsToDemoCustomer = customerIds.has(String((inv as any).customer_id));
      const isDemoNumber = /^TEST-INV-/.test(num);
      if (belongsToDemoCustomer || isDemoNumber) {
        await dbDelete(inv.pk, inv.sk);
      }
    }
  }

  let created = 0;
  let skipped = 0;
  for (const c of CUSTOMERS) {
    const existing = await findCustomerByName(user.id, c.name);
    if (existing) {
      skipped++;
      console.log(`SKIP (already exists): ${c.name}`);
      continue;
    }
    const { name, invoicePrefix, ...extra } = c;
    await createCustomer(user.id, name, extra);
    created++;
    console.log(`CREATED: ${c.name} (gstin=${c.gstin ?? "NULL"})`);
  }

  // --- Demo invoices: at least 3 per demo customer (idempotent) ---
  // Mix: 1 overdue open + 1 due-soon open + 1 paid/closed.
  let invoicesCreated = 0;
  let invoicesSkipped = 0;
  for (const c of CUSTOMERS) {
    const customer = await findCustomerByName(user.id, c.name);
    if (!customer) {
      console.log(`SKIP invoices (no such customer): ${c.name}`);
      continue;
    }
    const customerId = String((customer as any).id);
    const specs = [
      {
        // Overdue open invoice (issued 60 days ago, 30-day terms → overdue)
        invoice_number: `TEST-INV-${c.invoicePrefix}-001`,
        issue_date: isoDate(60),
        amount: DEMO_AMOUNTS[0],
        netDays: 30,
        status: "open" as const,
      },
      {
        // Due-soon open invoice (issued 5 days ago, 30-day terms → still open)
        invoice_number: `TEST-INV-${c.invoicePrefix}-002`,
        issue_date: isoDate(5),
        amount: DEMO_AMOUNTS[1],
        netDays: 30,
        status: "open" as const,
      },
      {
        // Paid invoice (issued 90 days ago, closed with zero balance)
        invoice_number: `TEST-INV-${c.invoicePrefix}-003`,
        issue_date: isoDate(90),
        amount: DEMO_AMOUNTS[2],
        netDays: 30,
        status: "closed" as const,
      },
    ];
    for (const s of specs) {
      const already = await findInvoiceByNumber(user.id, customerId, s.invoice_number);
      if (already) {
        invoicesSkipped++;
        continue;
      }
      const due_date = dueDate(s.issue_date, s.netDays);
      const isClosed = s.status === "closed";
      const row = await createInvoice(user.id, {
        customer_id: customerId,
        invoice_number: s.invoice_number,
        issue_date: s.issue_date,
        due_date,
        amount: s.amount,
        balance: isClosed ? 0 : s.amount,
        status: s.status,
      });
      if (isClosed) {
        await updateInvoice(user.id, String((row as any).id), {
          closed_date: due_date,
          payment_days: s.netDays,
          late_payment_days: 0,
        });
      }
      invoicesCreated++;
      console.log(`CREATED invoice: ${s.invoice_number} for ${c.name} (${s.status}, ₹${s.amount})`);
    }
  }

  // Sanity check: every demo customer should now have >= 3 invoices.
  const allInvoices = await listInvoices(user.id);
  for (const c of CUSTOMERS) {
    const customer = await findCustomerByName(user.id, c.name);
    if (!customer) continue;
    const count = allInvoices.filter((i) => (i as any).customer_id === (customer as any).id).length;
    if (count < 3) console.warn(`WARNING: ${c.name} has only ${count} invoice(s), expected >= 3`);
  }

  console.log(`Seed for ${user.email}: ${created} customers created, ${skipped} already present.`);
  console.log(`Invoices: ${invoicesCreated} created, ${invoicesSkipped} already present (>=3 per demo customer).`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
