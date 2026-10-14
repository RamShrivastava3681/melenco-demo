/**
 * Phase 4 test-data seeder (DUMMY DATA ONLY — never run against live data).
 *
 * Creates the one simple acceptance invoice for a tenant (a user id):
 *   - 1 customer  ("Phase4 Customer")
 *   - 1 SKU       ("Phase4 Widget", qty unit Nos, 18% GST)
 *   - 1 invoice   ("PH4-0001", 10 x 1000 + 18% GST = 11800)
 *
 * No discounts, freight, advances, multiple lines or multiple taxes.
 *
 * Usage:
 *   npx tsx scripts/seed-phase4.ts <userId> [--reset]
 *
 * With --reset, previously seeded Phase4 rows for the tenant are removed
 * first so the script is re-runnable. After seeding:
 *   1. Pair/select the Tally company in the connector.
 *   2. Ensure "Phase4 Customer" ledger and "Phase4 Widget" stock item exist
 *      in that Tally company (Phase 3 master sync or manual creation).
 *   3. POST /api/integrations/tally/invoices/push with the printed invoice id.
 *   4. Watch the connector logs for the Phase 4 chain
 *      (TALLY_COMPANY_SELECTED → … → VOUCHER_READ_BACK_FOUND →
 *      VOUCHER_ACK_COMPLETED → COMMAND_COMPLETED).
 *   5. Confirm the invoice flips to COMPLETED with the Tally voucher number.
 */
import "dotenv/config";
import { initializeDatabase, getUserById } from "../src/db/index.js";
import { dbPut, dbQueryPk, dbDelete, dbScan } from "../src/db/dynamo.js";
import { userPk, customerSk, productSk, invoiceSk, nowIso } from "../src/db/keys.js";

const CUSTOMER_NAME = "Phase4 Customer";
const SKU_NAME = "Phase4 Widget";
const INVOICE_NUMBER = "PH4-0001";

async function main(): Promise<void> {
  const userId = process.argv[2];
  const reset = process.argv.includes("--reset");
  if (!userId) {
    console.error("Usage: npx tsx scripts/seed-phase4.ts <userId> [--reset]");
    process.exit(1);
  }

  const table = (process.env.DYNAMODB_TABLE_PREFIX || "").toLowerCase();
  if (process.env.NODE_ENV === "production" || table.includes("prod")) {
    console.error("Refusing to seed: production environment detected. Use dummy/test data only.");
    process.exit(1);
  }

  await initializeDatabase();

  const user = await getUserById(userId);
  if (!user) {
    console.error(`No such user: ${userId}`);
    process.exit(1);
  }

  if (reset) {
    for (const [prefix, match] of [
      ["CUSTOMER#", CUSTOMER_NAME],
      ["PRODUCT#", SKU_NAME],
      ["INVOICE#", INVOICE_NUMBER],
    ] as const) {
      const rows = await dbQueryPk(userPk(userId), prefix);
      for (const r of rows) {
        const hit =
          prefix === "INVOICE#"
            ? String(r.invoice_number || "") === match
            : String(r.name || "") === match;
        if (hit) await dbDelete(r.pk, r.sk);
      }
    }
    // Drop any invoice-linked sync residue for this tenant's Phase4 invoice.
    try {
      const linked = await dbScan(
        (it) => it.pk === userPk(userId) && String((it as { invoice_number?: unknown }).invoice_number || "") === INVOICE_NUMBER
      );
      for (const l of linked) {
        if (String(l.sk || "").startsWith("INVOICE#")) continue; // already handled
        await dbDelete(l.pk, l.sk);
      }
    } catch { /* best-effort */ }
  }

  // 1. One customer.
  let customer = (await dbQueryPk(userPk(userId), "CUSTOMER#")).find((r) => String(r.name || "") === CUSTOMER_NAME);
  if (!customer) {
    customer = {
      pk: userPk(userId),
      sk: customerSk("seed-phase4-cust"),
      recordType: "CUSTOMER",
      id: "seed-phase4-cust",
      user_id: userId,
      name: CUSTOMER_NAME,
      created_at: nowIso(),
      version: 1,
    };
    await dbPut(customer);
    console.log(`customer: created "${CUSTOMER_NAME}" (${customer.id})`);
  } else {
    console.log(`customer: exists "${CUSTOMER_NAME}" (${customer.id})`);
  }

  // 2. One SKU.
  let sku = (await dbQueryPk(userPk(userId), "PRODUCT#")).find((r) => String(r.name || "") === SKU_NAME);
  if (!sku) {
    sku = {
      pk: userPk(userId),
      sk: productSk("seed-phase4-sku"),
      recordType: "PRODUCT",
      id: "seed-phase4-sku",
      user_id: userId,
      name: SKU_NAME,
      sku_code: SKU_NAME,
      hsn: "8471",
      gst_rate: 18,
      base_unit: "Nos",
      group_name: "Phase4 Goods",
      created_at: nowIso(),
      version: 1,
    };
    await dbPut(sku);
    console.log(`sku: created "${SKU_NAME}" (${sku.id})`);
  } else {
    console.log(`sku: exists "${SKU_NAME}" (${sku.id})`);
  }

  // 3. One invoice: 10 x 1000 + 18% GST = 11800.
  const quantity = 10;
  const unitPrice = 1000;
  const gstRate = 18;
  const taxable = quantity * unitPrice;
  const grandTotal = taxable + (taxable * gstRate) / 100;
  let invoice = (await dbQueryPk(userPk(userId), "INVOICE#")).find(
    (r) => String(r.invoice_number || "") === INVOICE_NUMBER
  );
  if (!invoice) {
    invoice = {
      pk: userPk(userId),
      sk: invoiceSk("seed-phase4-inv"),
      recordType: "INVOICE",
      id: "seed-phase4-inv",
      user_id: userId,
      customer_id: customer.id,
      invoice_number: INVOICE_NUMBER,
      issue_date: new Date().toISOString().slice(0, 10),
      due_date: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
      amount: grandTotal,
      balance: grandTotal,
      status: "open",
      quantity,
      unit: "Nos",
      unit_price: unitPrice,
      gst_rate: gstRate,
      sku_id: sku.id,
      sku_code: SKU_NAME,
      grand_total: grandTotal,
      version: 1,
      created_at: nowIso(),
    };
    await dbPut(invoice);
    console.log(`invoice: created "${INVOICE_NUMBER}" (${invoice.id}) amount=${grandTotal}`);
  } else {
    console.log(`invoice: exists "${INVOICE_NUMBER}" (${invoice.id}) status=${invoice.status}`);
  }

  console.log(`\nPhase 4 seed for ${user.email} (${userId}) done.`);
  console.log(`Next: POST /api/integrations/tally/invoices/push { connectorId, companyId, invoiceIds: ["${invoice.id}"] }`);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
