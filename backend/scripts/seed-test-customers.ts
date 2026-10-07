/**
 * Test-customer seeder (DUMMY DATA ONLY).
 *
 * Creates 5 customers for master-sync testing:
 *   - 3 with valid GSTIN (registered dealers)
 *   - 2 with NULL GSTIN (B2C / unregistered — exercises the optional-GSTIN path)
 *
 * Usage (on the machine hosting the cloud DB):
 *   npx tsx scripts/seed-test-customers.ts <userEmail> [--reset]
 *
 * With --reset, rows named 'Test Customer %' / 'Test B2C Customer %' for the
 * tenant are removed first so the script is re-runnable.
 */
import "dotenv/config";
import { randomUUID as uuidv4 } from "node:crypto";
import db, { initializeDatabase, saveDb } from "../src/db/index.js";

const CUSTOMERS = [
  {
    name: "Test Customer One",
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

async function main(): Promise<void> {
  const userEmail = process.argv[2];
  const reset = process.argv.includes("--reset");
  if (!userEmail) {
    console.error("Usage: npx tsx scripts/seed-test-customers.ts <userEmail> [--reset]");
    process.exit(1);
  }

  await initializeDatabase();

  const user = db.prepare(`SELECT id, email FROM users WHERE email = ?`).get(userEmail) as
    | { id: string; email: string }
    | undefined;
  if (!user) {
    console.error(`No such user: ${userEmail}`);
    process.exit(1);
  }

  if (reset) {
    db.prepare(`DELETE FROM customers WHERE user_id = ? AND (name LIKE 'Test Customer %' OR name LIKE 'Test B2C Customer %')`).run(user.id);
  }

  let created = 0;
  let skipped = 0;
  for (const c of CUSTOMERS) {
    const existing = db.prepare(`SELECT id FROM customers WHERE user_id = ? AND name = ?`).get(user.id, c.name) as
      | { id: string }
      | undefined;
    if (existing) {
      skipped++;
      console.log(`SKIP (already exists): ${c.name}`);
      continue;
    }
    db.prepare(
      `INSERT INTO customers (id, user_id, name, gstin, pan, address, state, pin, phone, email, payment_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uuidv4(), user.id, c.name, c.gstin, c.pan, c.address, c.state, c.pin, c.phone, c.email, c.payment_terms);
    created++;
    console.log(`CREATED: ${c.name} (gstin=${c.gstin ?? "NULL"})`);
  }

  saveDb();
  console.log(`Seed for ${user.email}: ${created} created, ${skipped} already present.`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
