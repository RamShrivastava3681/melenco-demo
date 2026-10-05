import db from "../../../db/index.js";
import { v4 as uuidv4 } from "uuid";
import { ApiError } from "../errors.js";
import type { NormalizeContext, NormalizedResult } from "./registry.js";

/**
 * Master-entity normalizers.
 *
 * Mappings:
 *   Ledger (party)  → customers (debtors) / suppliers
 *   Ledger (other)  → tally_ledgers (chart of accounts)
 *   Stock item      → products
 *   Group/Unit/etc. → tally_ledgers metadata / normalized masters
 */

interface MasterTarget {
  table: string;
  normalize: (ctx: NormalizeContext) => NormalizedResult;
}

function dataOf(ctx: NormalizeContext): Record<string, any> {
  return (ctx.record.data as Record<string, any>) ?? {};
}

/** Name for masters: top-level partyName or data.name. */
function masterName(ctx: NormalizeContext): string {
  const fromParty = typeof ctx.record.partyName === "string" ? ctx.record.partyName.trim() : "";
  const d = dataOf(ctx);
  const fromData = typeof d.name === "string" ? d.name.trim() : "";
  const name = fromParty || fromData;
  if (!name) {
    throw new ApiError("TALLY_DATA_INVALID", "Master record is missing a name");
  }
  return name;
}

/** Group/parent field, used for stock groups, ledger parents, categories. */
function parentOf(ctx: NormalizeContext): string | null {
  const d = dataOf(ctx);
  const p = d.parent || d.group || d.category;
  return typeof p === "string" && p.trim() ? p.trim() : null;
}

/** Insert a customer (debtor) if absent — matches existing customers table semantics. */
function upsertCustomer(userId: string, name: string): string {
  const existing = db
    .prepare(`SELECT id FROM customers WHERE user_id = ? AND LOWER(name) = LOWER(?)`)
    .get(userId, name) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = uuidv4();
  db.prepare(`INSERT OR IGNORE INTO customers (id, user_id, name) VALUES (?, ?, ?)`).run(id, userId, name);
  const row = db
    .prepare(`SELECT id FROM customers WHERE user_id = ? AND LOWER(name) = LOWER(?)`)
    .get(userId, name) as { id: string } | undefined;
  return row!.id;
}

/** Insert a supplier if absent. */
function upsertSupplier(userId: string, name: string): string {
  const existing = db
    .prepare(`SELECT id FROM suppliers WHERE user_id = ? AND LOWER(name) = LOWER(?)`)
    .get(userId, name) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = uuidv4();
  db.prepare(`INSERT OR IGNORE INTO suppliers (id, user_id, name) VALUES (?, ?, ?)`).run(id, userId, name);
  const row = db
    .prepare(`SELECT id FROM suppliers WHERE user_id = ? AND LOWER(name) = LOWER(?)`)
    .get(userId, name) as { id: string } | undefined;
  return row!.id;
}

export const MASTER_TARGETS: Record<string, MasterTarget> = {
  COMPANY: {
    table: "tally_companies",
    normalize: (ctx) => {
      const d = dataOf(ctx);
      const name = masterName(ctx);
      db.prepare(
        `UPDATE tally_companies SET tally_company_name = ?, display_name = COALESCE(?, display_name) WHERE id = ?`
      ).run(name, (d.display as string) || null, ctx.companyId);
      return { table: "tally_companies", recordId: ctx.companyId };
    },
  },
  GROUP: {
    table: "tally_ledgers",
    normalize: (ctx) => {
      const name = masterName(ctx);
      const id = uuidv4();
      db.prepare(
        `INSERT OR IGNORE INTO tally_ledgers (id, user_id, company_id, name, parent_group, ledger_type)
         VALUES (?, ?, ?, ?, ?, 'GROUP')`
      ).run(id, ctx.userId, ctx.companyId, name, parentOf(ctx));
      const row = db
        .prepare(
          `SELECT id FROM tally_ledgers WHERE user_id = ? AND company_id = ? AND name = ? AND ledger_type = 'GROUP'`
        )
        .get(ctx.userId, ctx.companyId, name) as { id: string };
      return { table: "tally_ledgers", recordId: row.id };
    },
  },
  LEDGER: {
    table: "tally_ledgers",
    normalize: (ctx) => {
      const d = dataOf(ctx);
      const name = masterName(ctx);
      const parent = parentOf(ctx);
      const opening = typeof d.openingBalance === "number" ? d.openingBalance : Number(d.openingBalance) || 0;

      // Party ledgers map to WhizUnik customers/suppliers; others stay as ledgers
      const partyType = typeof d.partyType === "string" ? d.partyType.toLowerCase() : "";
      if (partyType === "debtor" || partyType === "customer") {
        const customerId = upsertCustomer(ctx.userId, name);
        ensureLedgerRow(ctx, name, parent, opening, "PARTY_DEBTOR");
        return { table: "customers", recordId: customerId };
      }
      if (partyType === "creditor" || partyType === "supplier") {
        const supplierId = upsertSupplier(ctx.userId, name);
        ensureLedgerRow(ctx, name, parent, opening, "PARTY_CREDITOR");
        return { table: "suppliers", recordId: supplierId };
      }

      const id = ensureLedgerRow(ctx, name, parent, opening, d.ledgerType || null);
      return { table: "tally_ledgers", recordId: id };
    },
  },
  STOCK_GROUP: {
    table: "tally_ledgers",
    normalize: (ctx) => {
      const name = masterName(ctx);
      const id = uuidv4();
      db.prepare(
        `INSERT OR IGNORE INTO tally_ledgers (id, user_id, company_id, name, parent_group, ledger_type)
         VALUES (?, ?, ?, ?, ?, 'STOCK_GROUP')`
      ).run(id, ctx.userId, ctx.companyId, name, parentOf(ctx));
      const row = db
        .prepare(
          `SELECT id FROM tally_ledgers WHERE user_id = ? AND company_id = ? AND name = ? AND ledger_type = 'STOCK_GROUP'`
        )
        .get(ctx.userId, ctx.companyId, name) as { id: string };
      return { table: "tally_ledgers", recordId: row.id };
    },
  },
  STOCK_CATEGORY: {
    table: "tally_ledgers",
    normalize: (ctx) => {
      const name = masterName(ctx);
      const id = uuidv4();
      db.prepare(
        `INSERT OR IGNORE INTO tally_ledgers (id, user_id, company_id, name, parent_group, ledger_type)
         VALUES (?, ?, ?, ?, ?, 'STOCK_CATEGORY')`
      ).run(id, ctx.userId, ctx.companyId, name, parentOf(ctx));
      const row = db
        .prepare(
          `SELECT id FROM tally_ledgers WHERE user_id = ? AND company_id = ? AND name = ? AND ledger_type = 'STOCK_CATEGORY'`
        )
        .get(ctx.userId, ctx.companyId, name) as { id: string };
      return { table: "tally_ledgers", recordId: row.id };
    },
  },
  STOCK_ITEM: {
    table: "products",
    normalize: (ctx) => {
      const d = dataOf(ctx);
      const name = masterName(ctx);
      const existing = db
        .prepare(`SELECT id FROM products WHERE user_id = ? AND LOWER(name) = LOWER(?)`)
        .get(ctx.userId, name) as { id: string } | undefined;

      if (existing) return { table: "products", recordId: existing.id };

      const id = uuidv4();
      db.prepare(
        `INSERT OR IGNORE INTO products (id, user_id, name, group_name, category, base_unit, description)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        ctx.userId,
        name,
        (d.group as string) || null,
        (d.category as string) || null,
        (d.baseUnit || d.unit as string) || null,
        (d.description as string) || null
      );
      const row = db
        .prepare(`SELECT id FROM products WHERE user_id = ? AND LOWER(name) = LOWER(?)`)
        .get(ctx.userId, name) as { id: string };
      return { table: "products", recordId: row.id };
    },
  },
  UNIT: {
    table: "tally_ledgers",
    normalize: (ctx) => {
      const name = masterName(ctx);
      const id = uuidv4();
      db.prepare(
        `INSERT OR IGNORE INTO tally_ledgers (id, user_id, company_id, name, ledger_type)
         VALUES (?, ?, ?, ?, 'UNIT')`
      ).run(id, ctx.userId, ctx.companyId, name);
      const row = db
        .prepare(
          `SELECT id FROM tally_ledgers WHERE user_id = ? AND company_id = ? AND name = ? AND ledger_type = 'UNIT'`
        )
        .get(ctx.userId, ctx.companyId, name) as { id: string };
      return { table: "tally_ledgers", recordId: row.id };
    },
  },
  GODOWN: {
    table: "tally_ledgers",
    normalize: (ctx) => {
      const name = masterName(ctx);
      const id = uuidv4();
      db.prepare(
        `INSERT OR IGNORE INTO tally_ledgers (id, user_id, company_id, name, ledger_type)
         VALUES (?, ?, ?, ?, 'GODOWN')`
      ).run(id, ctx.userId, ctx.companyId, name);
      const row = db
        .prepare(
          `SELECT id FROM tally_ledgers WHERE user_id = ? AND company_id = ? AND name = ? AND ledger_type = 'GODOWN'`
        )
        .get(ctx.userId, ctx.companyId, name) as { id: string };
      return { table: "tally_ledgers", recordId: row.id };
    },
  },
  VOUCHER_TYPE: {
    table: "tally_ledgers",
    normalize: (ctx) => {
      const name = masterName(ctx);
      const id = uuidv4();
      db.prepare(
        `INSERT OR IGNORE INTO tally_ledgers (id, user_id, company_id, name, ledger_type)
         VALUES (?, ?, ?, ?, 'VOUCHER_TYPE')`
      ).run(id, ctx.userId, ctx.companyId, name);
      const row = db
        .prepare(
          `SELECT id FROM tally_ledgers WHERE user_id = ? AND company_id = ? AND name = ? AND ledger_type = 'VOUCHER_TYPE'`
        )
        .get(ctx.userId, ctx.companyId, name) as { id: string };
      return { table: "tally_ledgers", recordId: row.id };
    },
  },
};

function ensureLedgerRow(
  ctx: NormalizeContext,
  name: string,
  parent: string | null,
  opening: number,
  ledgerType: string | null
): string {
  const existing = db
    .prepare(`SELECT id FROM tally_ledgers WHERE user_id = ? AND company_id = ? AND name = ?`)
    .get(ctx.userId, ctx.companyId, name) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE tally_ledgers SET parent_group = COALESCE(?, parent_group),
         opening_balance = ?, ledger_type = COALESCE(?, ledger_type), updated_at = datetime('now')
       WHERE id = ?`
    ).run(parent, opening, ledgerType, existing.id);
    return existing.id;
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO tally_ledgers (id, user_id, company_id, name, parent_group, ledger_type, opening_balance)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ctx.userId, ctx.companyId, name, parent, ledgerType, opening);
  return id;
}

/** Dispatch helper used by the registry. */
export function normalizeMaster(ctx: NormalizeContext): NormalizedResult {
  const target = MASTER_TARGETS[ctx.entityType];
  if (!target) {
    throw new ApiError("NORMALIZATION_FAILED", `Unsupported master entity ${ctx.entityType}`);
  }
  return target.normalize(ctx);
}

/** Number of master target entries (used in tests). */
export const MASTER_ENTITY_TYPES = Object.keys(MASTER_TARGETS);
