/**
 * Phase 3 test-data seeder (DUMMY DATA ONLY — never run against live data).
 *
 * Seeds the spec §10 matrix for one tenant (a user id):
 *   - 2 valid customers, 2 valid suppliers, 3 valid SKUs
 *   - 1 duplicate customer (same GSTIN, different WhizUnik id)
 *   - 1 duplicate SKU (same sku_code, different WhizUnik id)
 *   - 1 customer with missing GSTIN (rejected at push with a clear reason)
 *   - 1 SKU with an invalid GST rate (rejected at push)
 *   - 1 SKU with a missing unit (rejected at push)
 *
 * Usage:
 *   npx tsx scripts/seed-phase3.ts <userId> [--reset]
 *
 * With --reset, previously seeded rows for the tenant (name LIKE 'Phase3 %')
 * are removed first so the script is re-runnable.
 */
import "dotenv/config";
import db, { initializeDatabase } from "../src/db/index.js";

const PREFIX = "Phase3 ";

interface SeedSpec {
  table: "customers" | "suppliers" | "products";
  id: string;
  name: string;
  cols: Record<string, unknown>;
}

const SEED: SeedSpec[] = [
  {
    table: "customers", id: "seed-cust-1", name: `${PREFIX}Customer One`,
    cols: { gstin: "29ABCDE1234F1Z5", pan: "ABCDE1234F", address: "42 Test Street, Bengaluru", state: "Karnataka", pin: "560001", phone: "9876543210", email: "customer.one@example.test", payment_terms: "Net 30" },
  },
  {
    table: "customers", id: "seed-cust-2", name: `${PREFIX}Customer Two`,
    cols: { gstin: "27ABCDE1234F2Z3", pan: "ABCDE1234G", address: "7 Test Avenue, Mumbai", state: "Maharashtra", pin: "400001", phone: "9123456780", email: "customer.two@example.test", payment_terms: "Net 15" },
  },
  // Duplicate customer: same GSTIN as Customer One, different WhizUnik id.
  {
    table: "customers", id: "seed-cust-dup", name: `${PREFIX}Customer One (Duplicate)`,
    cols: { gstin: "29ABCDE1234F1Z5", pan: "ABCDE1234F", address: "42 Test Street, Bengaluru", state: "Karnataka", pin: "560001", phone: "9876543210", email: "customer.dup@example.test", payment_terms: "Net 30" },
  },
  // Missing GSTIN → rejected at push with a clear reason.
  {
    table: "customers", id: "seed-cust-nogst", name: `${PREFIX}Customer No GSTIN`,
    cols: {},
  },
  {
    table: "suppliers", id: "seed-supp-1", name: `${PREFIX}Supplier One`,
    cols: { gstin: "29XYZAB1234C1Z4", pan: "XYZAB1234C", address: "9 Supply Lane, Bengaluru", state: "Karnataka", pin: "560002", phone: "9888877776", email: "supplier.one@example.test", payment_terms: "Net 45" },
  },
  {
    table: "suppliers", id: "seed-supp-2", name: `${PREFIX}Supplier Two`,
    cols: { gstin: "06XYZAB1234C2Z9", pan: "XYZAB1234D", address: "3 Trader Road, Delhi", state: "Delhi", pin: "110001", phone: "9111122223", email: "supplier.two@example.test", payment_terms: "Advance" },
  },
  {
    table: "products", id: "seed-sku-1", name: `${PREFIX}Widget A`,
    cols: { sku_code: "P3-WIDGET-A", hsn: "8471", gst_rate: 18, base_unit: "Nos", group_name: `${PREFIX}Goods` },
  },
  {
    table: "products", id: "seed-sku-2", name: `${PREFIX}Widget B`,
    cols: { sku_code: "P3-WIDGET-B", hsn: "8473", gst_rate: 12, base_unit: "Box", group_name: `${PREFIX}Goods` },
  },
  {
    table: "products", id: "seed-sku-3", name: `${PREFIX}Gadget C`,
    cols: { sku_code: "P3-GADGET-C", hsn: "8517", gst_rate: 28, base_unit: "Pcs", group_name: `${PREFIX}Electronics` },
  },
  // Duplicate SKU: same sku_code as Widget A, different WhizUnik id.
  {
    table: "products", id: "seed-sku-dup", name: `${PREFIX}Widget A (Duplicate)`,
    cols: { sku_code: "P3-WIDGET-A", hsn: "8471", gst_rate: 18, base_unit: "Nos", group_name: `${PREFIX}Goods` },
  },
  // Invalid GST rate → rejected at push.
  {
    table: "products", id: "seed-sku-badrate", name: `${PREFIX}Bad Rate Item`,
    cols: { sku_code: "P3-BADRATE", hsn: "8471", gst_rate: 99, base_unit: "Nos", group_name: `${PREFIX}Goods` },
  },
  // Missing unit → rejected at push.
  {
    table: "products", id: "seed-sku-nounit", name: `${PREFIX}No Unit Item`,
    cols: { sku_code: "P3-NOUNIT", hsn: "8471", gst_rate: 12, base_unit: null, group_name: `${PREFIX}Goods` },
  },
];

async function main(): Promise<void> {
  const userId = process.argv[2];
  const reset = process.argv.includes("--reset");
  if (!userId) {
    console.error("Usage: npx tsx scripts/seed-phase3.ts <userId> [--reset]");
    process.exit(1);
  }

  // Safety: never seed a production database file.
  const dbUrl = (process.env.DATABASE_URL || "").toLowerCase();
  if (process.env.NODE_ENV === "production" || dbUrl.includes("prod")) {
    console.error("Refusing to seed: production environment detected. Use dummy/test data only.");
    process.exit(1);
  }

  await initializeDatabase();

  const user = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(userId) as
    | { id: string; email: string }
    | undefined;
  if (!user) {
    console.error(`No such user: ${userId}`);
    process.exit(1);
  }

  if (reset) {
    for (const table of ["customers", "suppliers", "products"] as const) {
      try {
        db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND name LIKE '${PREFIX}%'`).run(userId);
      } catch (err) {
        console.error(`Reset failed for ${table}:`, err);
        process.exit(1);
      }
    }
    try {
      db.prepare(`DELETE FROM master_sync_links WHERE tenant_id = ?`).run(userId);
      db.prepare(`DELETE FROM master_sync_attempts WHERE tenant_id = ?`).run(userId);
    } catch { /* links tables always exist with the whizunik schema */ }
  }

  let created = 0;
  let skipped = 0;
  for (const s of SEED) {
    const existing = db.prepare(`SELECT id FROM ${s.table} WHERE id = ?`).get(s.id) as { id: string } | undefined;
    if (existing) {
      skipped++;
      continue;
    }
    const cols = ["id", "user_id", "name", ...Object.keys(s.cols)];
    const placeholders = cols.map(() => "?").join(", ");
    const values = [s.id, userId, s.name, ...Object.values(s.cols)];
    db.prepare(`INSERT INTO ${s.table} (${cols.join(", ")}) VALUES (${placeholders})`).run(...values);
    created++;
  }

  console.log(`Phase 3 seed for ${user.email} (${userId}): ${created} created, ${skipped} already present.`);
  console.log("Valid: 2 customers, 2 suppliers, 3 SKUs. Edge: 1 dup customer, 1 dup SKU, 1 missing GSTIN, 1 bad GST rate, 1 missing unit.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
