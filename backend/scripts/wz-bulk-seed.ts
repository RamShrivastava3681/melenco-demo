/**
 * Bulk test-data seeder + push queuer (DUMMY DATA ONLY).
 *
 * Phase A (always): create 100 customers + 50 suppliers + 50 SKUs for the
 * tenant, names prefixed "Bulk ...", unique valid-format dummy GSTINs.
 * Idempotent: existing names are skipped.
 *
 * Phase B (--queue <connectorPublicId>): validate every master with the
 * same backend schemas the /masters/push route uses, then create one
 * PUSH_MASTERS command per item + QUEUED link. Requires the connector to
 * exist and be ACTIVE for this tenant.
 *
 * Usage:
 *   npx tsx scripts/wz-bulk-seed-tmp.ts [--reset] [--queue <connectorPublicId>]
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { initializeDatabase } from "../src/db/index.js";
import {
  findCustomerByName, createCustomer, listCustomers,
  findSupplierByName, createSupplier, listSuppliers,
  findProductByName, createProduct, listProducts,
} from "../src/db/storesCore.js";
import { dbDelete } from "../src/db/dynamo.js";
import {
  createWCommand, getWConnectorByPublicId, putMasterLink, latestWCompanyForTenant, getMasterLink,
} from "../src/db/storesWhizunik.js";
import {
  GSTIN_REGEX, PAN_REGEX, wzMasterCustomerSchema, wzMasterSupplierSchema, wzMasterSkuSchema,
  masterIdempotencyKey,
} from "../src/integrations/tally/whizunik/validate.js";

const USER_ID = "a17ec88f-c5a3-4826-a469-07a29105b3a6";
const N_CUSTOMERS = 100;
const N_SUPPLIERS = 50;
const N_SKUS = 50;

const CITIES = [
  { city: "Bengaluru", state: "Karnataka", pin: "560001" },
  { city: "Mumbai", state: "Maharashtra", pin: "400001" },
  { city: "Delhi", state: "Delhi", pin: "110001" },
  { city: "Chennai", state: "Tamil Nadu", pin: "600001" },
  { city: "Kolkata", state: "West Bengal", pin: "700001" },
];
const RATES = [0, 5, 12, 18, 28];
const UNITS = ["Nos", "Box", "Pcs", "Kg", "Mtr"];

const L = (n: number): string => String.fromCharCode(65 + ((n % 26 + 26) % 26));
const usedGstins = new Set<string>();

function makeGstin(i: number, salt: number): string {
  // 29 + 5 letters + 4 digits + letter + alnum + Z + alnum (unique per record)
  const g = `29${L(i + salt)}${L(i * 3 + salt)}${L(i * 7 + salt)}${L(i * 11 + salt)}${L(i * 13 + salt)}${String(1000 + ((i * 37 + salt * 101) % 9000))}${L(i + salt + 1)}${(i + salt) % 10}Z${(i * 7 + salt) % 10}`;
  if (usedGstins.has(g)) return makeGstin(i, salt + 1);
  if (!GSTIN_REGEX.test(g)) throw new Error(`generated bad GSTIN: ${g}`);
  usedGstins.add(g);
  return g;
}

function makePan(i: number, salt: number): string {
  const p = `${L(i + salt)}${L(i + 1)}${L(i + 2)}${L(i + 3)}${L(i + 4)}${String(1000 + ((i * 13 + salt) % 9000))}${L(i + 5)}`;
  if (!PAN_REGEX.test(p)) throw new Error(`generated bad PAN: ${p}`);
  return p;
}

async function seed(): Promise<{ customers: string[]; suppliers: string[]; skus: string[] }> {
  const customers: string[] = [];
  const suppliers: string[] = [];
  const skus: string[] = [];
  let created = 0;
  let skipped = 0;

  for (let i = 1; i <= N_CUSTOMERS; i++) {
    const name = `Bulk Customer ${String(i).padStart(3, "0")}`;
    const c = CITIES[i % CITIES.length];
    if (await findCustomerByName(USER_ID, name)) { skipped++; customers.push(name); continue; }
    const row = await createCustomer(USER_ID, name, {
      gstin: makeGstin(i, 1),
      pan: makePan(i, 1),
      address: `${i} Market Road, ${c.city}`,
      state: c.state,
      pin: c.pin,
      phone: `98${String(10000000 + i)}`,
      email: `bulk.customer.${String(i).padStart(3, "0")}@example.test`,
      payment_terms: i % 2 === 0 ? "Net 30" : "Net 15",
    });
    customers.push(name);
    created++;
    void row;
  }
  for (let i = 1; i <= N_SUPPLIERS; i++) {
    const name = `Bulk Supplier ${String(i).padStart(3, "0")}`;
    const c = CITIES[(i + 2) % CITIES.length];
    if (await findSupplierByName(USER_ID, name)) { skipped++; suppliers.push(name); continue; }
    await createSupplier(USER_ID, name, {
      gstin: makeGstin(i, 500),
      pan: makePan(i, 500),
      address: `${i} Supply Lane, ${c.city}`,
      state: c.state,
      pin: c.pin,
      phone: `97${String(10000000 + i)}`,
      email: `bulk.supplier.${String(i).padStart(3, "0")}@example.test`,
      payment_terms: "Net 45",
    });
    suppliers.push(name);
    created++;
  }
  for (let i = 1; i <= N_SKUS; i++) {
    const name = `Bulk Widget ${String(i).padStart(3, "0")}`;
    if (await findProductByName(USER_ID, name)) { skipped++; skus.push(name); continue; }
    await createProduct(USER_ID, {
      name,
      sku_code: `BULK-W-${String(i).padStart(3, "0")}`,
      hsn: String(8400 + i),
      gst_rate: RATES[i % RATES.length],
      base_unit: UNITS[i % UNITS.length],
      group_name: "Bulk Goods",
    });
    skus.push(name);
    created++;
  }
  console.log(`SEED: ${created} created, ${skipped} already present (customers=${customers.length} suppliers=${suppliers.length} skus=${skus.length})`);
  return { customers, suppliers, skus };
}

async function reset(): Promise<void> {
  let removed = 0;
  for (const r of await listCustomers(USER_ID)) {
    if (String((r as any).name ?? "").startsWith("Bulk Customer ")) {
      const link = await getMasterLink(USER_ID, "customer", String((r as any).id));
      if (link) await dbDelete(link.pk, link.sk);
      await dbDelete((r as any).pk, (r as any).sk);
      removed++;
    }
  }
  for (const r of await listSuppliers(USER_ID)) {
    if (String((r as any).name ?? "").startsWith("Bulk Supplier ")) {
      const link = await getMasterLink(USER_ID, "supplier", String((r as any).id));
      if (link) await dbDelete(link.pk, link.sk);
      await dbDelete((r as any).pk, (r as any).sk);
      removed++;
    }
  }
  for (const r of await listProducts(USER_ID, 500)) {
    if (String((r as any).name ?? "").startsWith("Bulk Widget ")) {
      const link = await getMasterLink(USER_ID, "sku", String((r as any).id));
      if (link) await dbDelete(link.pk, link.sk);
      await dbDelete((r as any).pk, (r as any).sk);
      removed++;
    }
  }
  console.log(`RESET: removed ${removed} Bulk rows (+links)`);
}

function fieldsFor(kind: string, row: Record<string, unknown>): Record<string, unknown> {
  if (kind === "sku") {
    return {
      skuCode: row.sku_code ?? null, name: row.name ?? null, hsn: row.hsn ?? null,
      gstRate: row.gst_rate ?? null, unit: row.base_unit ?? null,
      category: row.group_name ?? row.category ?? null,
    };
  }
  return {
    name: row.name ?? null, gstin: row.gstin ?? null, pan: row.pan ?? null,
    address: row.address ?? null, state: row.state ?? null, pin: row.pin ?? null,
    phone: row.phone ?? null, email: row.email ?? null, paymentTerms: row.payment_terms ?? null,
  };
}

async function queue(connectorPublicId: string): Promise<void> {
  const conn = await getWConnectorByPublicId(connectorPublicId);
  if (!conn || (conn as any).tenant_id !== USER_ID) {
    console.error("Connector not found for this account");
    process.exit(1);
  }
  if ((conn as any).status !== "active") {
    console.error(`Connector ${(conn as any).connector_id} status=${(conn as any).status} (need active — pair the connector first)`);
    process.exit(1);
  }
  const company = await latestWCompanyForTenant(USER_ID);
  if (!company) {
    console.error("No WhizUnik company found for this account");
    process.exit(1);
  }
  console.log(`QUEUE via ${(conn as any).connector_id}, company ${(company as any).id} (${(company as any).name ?? ""})`);

  const items: Array<{ kind: "customer" | "supplier" | "sku"; row: Record<string, unknown> }> = [];
  for (const r of await listCustomers(USER_ID)) {
    if (String((r as any).name ?? "").startsWith("Bulk Customer ")) items.push({ kind: "customer", row: r as Record<string, unknown> });
  }
  for (const r of await listSuppliers(USER_ID)) {
    if (String((r as any).name ?? "").startsWith("Bulk Supplier ")) items.push({ kind: "supplier", row: r as Record<string, unknown> });
  }
  for (const r of await listProducts(USER_ID, 500)) {
    if (String((r as any).name ?? "").startsWith("Bulk Widget ")) items.push({ kind: "sku", row: r as Record<string, unknown> });
  }

  let queued = 0;
  let rejected = 0;
  for (const { kind, row } of items) {
    const id = String(row.id);
    const version = typeof row.version === "number" && (row.version as number) > 0 ? (row.version as number) : 1;
    const fields = fieldsFor(kind, row);
    const schema = kind === "customer" ? wzMasterCustomerSchema : kind === "supplier" ? wzMasterSupplierSchema : wzMasterSkuSchema;
    const check = schema.safeParse(fields);
    if (!check.success) {
      rejected++;
      console.log(`REJECTED ${kind} ${row.name}: ${check.error.issues.map((x) => x.message).join("; ")}`);
      continue;
    }
    const idempotencyKey = masterIdempotencyKey(kind, id, version);
    const cmdId = `cmd_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await createWCommand({
      id: cmdId,
      tenant_id: USER_ID,
      connector_id: (conn as any).connector_id,
      command: "PUSH_MASTERS",
      payload: JSON.stringify({ companyId: (company as any).id, master: { kind, id, version, idempotencyKey, fields } }),
    });
    await putMasterLink({
      tenant_id: USER_ID, kind, whizunik_id: id, version, status: "QUEUED", attempts: 1,
      idempotency_key: idempotencyKey, direction: "outbound", request_id: cmdId, approved_by: USER_ID,
    });
    queued++;
  }
  console.log(`QUEUED: ${queued} PUSH_MASTERS commands, ${rejected} rejected`);
}

async function main(): Promise<void> {
  await initializeDatabase();
  const args = process.argv.slice(2);
  if (args.includes("--reset")) await reset();
  await seed();
  const qi = args.indexOf("--queue");
  if (qi >= 0) {
    const connectorPublicId = args[qi + 1];
    if (!connectorPublicId) {
      console.error("Usage: --queue <connectorPublicId>");
      process.exit(1);
    }
    await queue(connectorPublicId);
  } else {
    console.log(" Masters seeded. Queue later with: --queue <connectorPublicId> (connector must be ACTIVE).");
  }
}

void main().catch((err) => { console.error("FAILED:", err instanceof Error ? err.message : String(err)); process.exit(1); });
