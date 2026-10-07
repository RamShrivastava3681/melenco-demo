import {
  findCustomerByName,
  createCustomer,
  findSupplierByName,
  createSupplier,
  findProductByName,
  createProduct,
} from "../../../db/storesCore.js";
import {
  findLedger,
  createLedger,
  updateLedger,
  getCompany,
} from "../../../db/storesTally.js";
import { dbUpdate } from "../../../db/dynamo.js";
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
  normalize: (ctx: NormalizeContext) => Promise<NormalizedResult>;
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
async function upsertCustomer(userId: string, name: string): Promise<string> {
  const existing = await findCustomerByName(userId, name);
  if (existing) return existing.id as string;
  try {
    const created = await createCustomer(userId, name);
    return created.id as string;
  } catch {
    const again = await findCustomerByName(userId, name);
    return again!.id as string;
  }
}

/** Insert a supplier if absent. */
async function upsertSupplier(userId: string, name: string): Promise<string> {
  const existing = await findSupplierByName(userId, name);
  if (existing) return existing.id as string;
  const created = await createSupplier(userId, name);
  return created.id as string;
}

async function upsertLedgerType(
  ctx: NormalizeContext,
  name: string,
  ledgerType: string
): Promise<string> {
  const existing = await findLedger(ctx.userId, ctx.companyId, name);
  if (existing && existing.ledger_type === ledgerType) return existing.id as string;
  if (existing) {
    await updateLedger(existing, { parent_group: parentOf(ctx) ?? existing.parent_group, ledger_type: ledgerType });
    return existing.id as string;
  }
  const created = await createLedger({
    user_id: ctx.userId,
    company_id: ctx.companyId,
    name,
    parent_group: parentOf(ctx),
    ledger_type: ledgerType,
  });
  return created.id as string;
}

export const MASTER_TARGETS: Record<string, MasterTarget> = {
  COMPANY: {
    table: "tally_companies",
    normalize: async (ctx) => {
      const d = dataOf(ctx);
      const name = masterName(ctx);
      const company = await getCompany(ctx.userId, ctx.companyId);
      if (company) {
        await dbUpdate(company.pk, company.sk, {
          tally_company_name: name,
          display_name: (d.display as string) || company.display_name || null,
        });
      }
      return { table: "tally_companies", recordId: ctx.companyId };
    },
  },
  GROUP: {
    table: "tally_ledgers",
    normalize: async (ctx) => {
      const name = masterName(ctx);
      const recordId = await upsertLedgerType(ctx, name, "GROUP");
      return { table: "tally_ledgers", recordId };
    },
  },
  LEDGER: {
    table: "tally_ledgers",
    normalize: async (ctx) => {
      const d = dataOf(ctx);
      const name = masterName(ctx);
      const parent = parentOf(ctx);
      const opening = typeof d.openingBalance === "number" ? d.openingBalance : Number(d.openingBalance) || 0;

      // Party ledgers map to WhizUnik customers/suppliers; others stay as ledgers
      const partyType = typeof d.partyType === "string" ? d.partyType.toLowerCase() : "";
      if (partyType === "debtor" || partyType === "customer") {
        const customerId = await upsertCustomer(ctx.userId, name);
        await ensureLedgerRow(ctx, name, parent, opening, "PARTY_DEBTOR");
        return { table: "customers", recordId: customerId };
      }
      if (partyType === "creditor" || partyType === "supplier") {
        const supplierId = await upsertSupplier(ctx.userId, name);
        await ensureLedgerRow(ctx, name, parent, opening, "PARTY_CREDITOR");
        return { table: "suppliers", recordId: supplierId };
      }

      const id = await ensureLedgerRow(ctx, name, parent, opening, d.ledgerType || null);
      return { table: "tally_ledgers", recordId: id };
    },
  },
  STOCK_GROUP: {
    table: "tally_ledgers",
    normalize: async (ctx) => {
      const name = masterName(ctx);
      const recordId = await upsertLedgerType(ctx, name, "STOCK_GROUP");
      return { table: "tally_ledgers", recordId };
    },
  },
  STOCK_CATEGORY: {
    table: "tally_ledgers",
    normalize: async (ctx) => {
      const name = masterName(ctx);
      const recordId = await upsertLedgerType(ctx, name, "STOCK_CATEGORY");
      return { table: "tally_ledgers", recordId };
    },
  },
  STOCK_ITEM: {
    table: "products",
    normalize: async (ctx) => {
      const d = dataOf(ctx);
      const name = masterName(ctx);
      const existing = await findProductByName(ctx.userId, name);

      if (existing) return { table: "products", recordId: existing.id as string };

      try {
        const created = await createProduct(ctx.userId, {
          name,
          group_name: (d.group as string) || null,
          category: (d.category as string) || null,
          base_unit: ((d.baseUnit || d.unit) as string) || null,
          description: (d.description as string) || null,
        });
        return { table: "products", recordId: created.id as string };
      } catch {
        const again = await findProductByName(ctx.userId, name);
        return { table: "products", recordId: again!.id as string };
      }
    },
  },
  UNIT: {
    table: "tally_ledgers",
    normalize: async (ctx) => {
      const name = masterName(ctx);
      const recordId = await upsertLedgerType(ctx, name, "UNIT");
      return { table: "tally_ledgers", recordId };
    },
  },
  GODOWN: {
    table: "tally_ledgers",
    normalize: async (ctx) => {
      const name = masterName(ctx);
      const recordId = await upsertLedgerType(ctx, name, "GODOWN");
      return { table: "tally_ledgers", recordId };
    },
  },
  VOUCHER_TYPE: {
    table: "tally_ledgers",
    normalize: async (ctx) => {
      const name = masterName(ctx);
      const recordId = await upsertLedgerType(ctx, name, "VOUCHER_TYPE");
      return { table: "tally_ledgers", recordId };
    },
  },
};

async function ensureLedgerRow(
  ctx: NormalizeContext,
  name: string,
  parent: string | null,
  opening: number,
  ledgerType: string | null
): Promise<string> {
  const existing = await findLedger(ctx.userId, ctx.companyId, name);

  if (existing) {
    const attrs: Record<string, any> = { opening_balance: opening };
    if (parent) attrs.parent_group = parent;
    if (ledgerType) attrs.ledger_type = ledgerType;
    await updateLedger(existing, attrs);
    return existing.id as string;
  }

  const created = await createLedger({
    user_id: ctx.userId,
    company_id: ctx.companyId,
    name,
    parent_group: parent,
    ledger_type: ledgerType,
    opening_balance: opening,
  });
  return created.id as string;
}

/** Dispatch helper used by the registry. */
export async function normalizeMaster(ctx: NormalizeContext): Promise<NormalizedResult> {
  const target = MASTER_TARGETS[ctx.entityType];
  if (!target) {
    throw new ApiError("NORMALIZATION_FAILED", `Unsupported master entity ${ctx.entityType}`);
  }
  return target.normalize(ctx);
}

/** Number of master target entries (used in tests). */
export const MASTER_ENTITY_TYPES = Object.keys(MASTER_TARGETS);
