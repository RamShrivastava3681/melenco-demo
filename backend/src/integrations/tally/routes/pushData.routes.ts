import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { requireAuth } from "../../../middleware/auth.js";
import { sendWzError } from "../whizunik/auth.js";
import { formatWzIssues } from "../whizunik/validate.js";
import {
  listVouchers,
  createVoucher,
  findLedger,
  createLedger,
} from "../../../db/storesTally.js";
import {
  listCustomers,
  listSuppliers,
  listProducts,
  createCustomer,
  findCustomerByName,
  findSupplierByName,
  findProductByName,
  createSupplier,
  createProduct,
} from "../../../db/storesCore.js";
import {
  getWConnectorByPublicId,
  getWCompany,
  createWCommand,
} from "../../../db/storesWhizunik.js";
import {
  getConnectorByPublicId as getLegacyConnector,
  getCompany as getLegacyCompany,
  createSyncCommand,
} from "../../../db/storesTally.js";
import { dbDelete, dbQueryPk, dbUpdate } from "../../../db/dynamo.js";
import { userPk } from "../../../db/keys.js";

const router = Router();

/**
 * Cloud "Tally push studio".
 *
 * Lets a user author Tally-shaped data in the cloud and queue it for the
 * on-prem connector (outbound-only: connector polls, nothing dials in):
 *
 *  Vouchers: SALES / PURCHASE / RECEIPT / PAYMENT / JOURNAL / CONTRA /
 *            DEBIT_NOTE / CREDIT_NOTE  → PUSH_VOUCHERS command
 *  Masters:  ledger / group / stock_item / stock_group / stock_category /
 *            unit / godown / voucher_type → stored in tally_ledgers/products,
 *            pushable via the existing masters/push (customer/supplier/sku)
 *            plus visible here as push-ready Tally data.
 *
 * Voucher drafts reuse the TALLY_VOUCHER store with direction=outbound so
 * inbound Tally syncs never collide with cloud-authored drafts.
 */

const VOUCHER_TYPES = [
  "SALES",
  "PURCHASE",
  "RECEIPT",
  "PAYMENT",
  "JOURNAL",
  "CONTRA",
  "DEBIT_NOTE",
  "CREDIT_NOTE",
] as const;

const CONNECTOR_VOUCHER_LABEL: Record<string, string> = {
  SALES: "Sales",
  PURCHASE: "Purchase",
  RECEIPT: "Receipt",
  PAYMENT: "Payment",
  JOURNAL: "Journal",
  CONTRA: "Contra",
  DEBIT_NOTE: "Debit Note",
  CREDIT_NOTE: "Credit Note",
};

const voucherSchema = z.object({
  voucherType: z.enum(VOUCHER_TYPES),
  voucherNumber: z.string().trim().min(1).max(100),
  voucherDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/, "voucherDate must be YYYY-MM-DD"),
  partyName: z.string().trim().min(1).max(300),
  amount: z.number().finite().positive().max(1_000_000_000),
  narration: z.string().trim().max(500).optional().default(""),
});

const pushVouchersSchema = z.object({
  connectorId: z.string().trim().min(1).max(120),
  companyId: z.string().trim().min(1).max(128),
  voucherIds: z.array(z.string().trim().min(1).max(128)).min(1).max(200),
});

const STOCK_KINDS = [
  "stock_item",
  "stock_group",
  "stock_category",
  "group",
  "ledger",
  "unit",
  "godown",
  "voucher_type",
] as const;

const stockSchema = z.object({
  kind: z.enum(STOCK_KINDS),
  name: z.string().trim().min(1).max(200),
  parent: z.string().trim().max(200).optional().default(""),
  unit: z.string().trim().max(40).optional().default(""),
  openingBalance: z.number().finite().optional().default(0),
  description: z.string().trim().max(500).optional().default(""),
});

function toPublicVoucher(r: any) {
  return {
    id: r.id,
    voucherType: r.voucher_type,
    voucherNumber: r.voucher_number,
    voucherDate: r.voucher_date,
    partyName: r.party_ledger,
    amount: Number(r.amount),
    narration: r.narration ?? "",
    status: r.push_status ?? "DRAFT",
    commandId: r.push_command_id ?? null,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------

/** GET /push-data/vouchers — outbound drafts authored in the cloud. */
router.get("/push-data/vouchers", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { type, status } = req.query as Record<string, string | undefined>;
    let rows = await listVouchers(userId);
    rows = rows.filter((r) => r.direction === "outbound");
    if (type) rows = rows.filter((r) => r.voucher_type === type);
    if (status) rows = rows.filter((r) => (r.push_status ?? "DRAFT") === status);
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    res.status(200).json({ vouchers: rows.map(toPublicVoucher) });
  } catch (err) {
    console.error("[push-data][vouchers/list] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

/** POST /push-data/vouchers — create one Tally-shaped voucher draft. */
router.post("/push-data/vouchers", requireAuth, async (req: Request, res: Response) => {
  const parsed = voucherSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
    return;
  }
  try {
    const userId = req.user!.userId;
    const input = parsed.data;
    // Natural-key dedupe: same type + number + date must not double-create.
    const existing = (await listVouchers(userId)).find(
      (r) =>
        r.direction === "outbound" &&
        r.voucher_type === input.voucherType &&
        r.voucher_number === input.voucherNumber.trim() &&
        String(r.voucher_date || "").slice(0, 10) === input.voucherDate.slice(0, 10)
    );
    if (existing) {
      sendWzError(res, "INVALID_PAYLOAD", `Draft ${input.voucherNumber} already exists for ${input.voucherDate}`);
      return;
    }
    const created = await createVoucher({
      user_id: userId,
      company_id: null,
      direction: "outbound",
      push_status: "DRAFT",
      voucher_type: input.voucherType,
      voucher_number: input.voucherNumber.trim(),
      voucher_date: input.voucherDate.slice(0, 10),
      party_ledger: input.partyName.trim(),
      amount: input.amount,
      narration: input.narration?.trim() || null,
      raw_json: JSON.stringify(input),
    });
    res.status(201).json({ voucher: toPublicVoucher(created) });
  } catch (err) {
    console.error("[push-data][vouchers/create] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

/** DELETE /push-data/vouchers/:id — delete a DRAFT (queued/pushed are locked). */
router.delete("/push-data/vouchers/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const id = req.params.id as string;
    const rows = await listVouchers(userId);
    const row = rows.find((r) => r.id === id && r.direction === "outbound");
    if (!row) {
      sendWzError(res, "INVALID_PAYLOAD", "Voucher draft not found for this account");
      return;
    }
    if ((row.push_status ?? "DRAFT") !== "DRAFT") {
      sendWzError(res, "INVALID_PAYLOAD", "Only DRAFT vouchers can be deleted — already queued for Tally");
      return;
    }
    await dbDelete(row.pk, row.sk);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("[push-data][vouchers/delete] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

/** POST /push-data/vouchers/seed — one-click sample Tally data to push. */
router.post("/push-data/vouchers/seed", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const today = new Date().toISOString().slice(0, 10);
    const samples: Array<z.infer<typeof voucherSchema>> = [
      { voucherType: "SALES", voucherNumber: "SALE-1001", voucherDate: today, partyName: "Sharma Traders", amount: 11800, narration: "Sales — 10 pcs @ 1000 + 18% GST" },
      { voucherType: "SALES", voucherNumber: "SALE-1002", voucherDate: today, partyName: "Gupta Enterprises", amount: 5900, narration: "Sales — FMCG carton" },
      { voucherType: "PURCHASE", voucherNumber: "PUR-2001", voucherDate: today, partyName: "Reliance Distributors", amount: 25000, narration: "Purchase — stock replenishment" },
      { voucherType: "RECEIPT", voucherNumber: "RCT-3001", voucherDate: today, partyName: "Sharma Traders", amount: 5000, narration: "Receipt — part payment received" },
      { voucherType: "PAYMENT", voucherNumber: "PMT-4001", voucherDate: today, partyName: "Reliance Distributors", amount: 10000, narration: "Payment — supplier advance" },
      { voucherType: "JOURNAL", voucherNumber: "JRN-5001", voucherDate: today, partyName: "GST Output CGST", amount: 900, narration: "Journal — GST adjustment" },
      { voucherType: "CONTRA", voucherNumber: "CTR-6001", voucherDate: today, partyName: "HDFC Current Account", amount: 50000, narration: "Contra — cash to bank" },
      { voucherType: "DEBIT_NOTE", voucherNumber: "DN-7001", voucherDate: today, partyName: "Reliance Distributors", amount: 1200, narration: "Debit note — purchase return" },
      { voucherType: "CREDIT_NOTE", voucherNumber: "CN-8001", voucherDate: today, partyName: "Gupta Enterprises", amount: 800, narration: "Credit note — sales return" },
    ];
    let created = 0;
    let skipped = 0;
    for (const s of samples) {
      const dup = (await listVouchers(userId)).find(
        (r) =>
          r.direction === "outbound" &&
          r.voucher_type === s.voucherType &&
          r.voucher_number === s.voucherNumber &&
          String(r.voucher_date || "").slice(0, 10) === s.voucherDate
      );
      if (dup) {
        skipped++;
        continue;
      }
      await createVoucher({
        user_id: userId,
        company_id: null,
        direction: "outbound",
        push_status: "DRAFT",
        voucher_type: s.voucherType,
        voucher_number: s.voucherNumber,
        voucher_date: s.voucherDate,
        party_ledger: s.partyName,
        amount: s.amount,
        narration: s.narration,
        raw_json: JSON.stringify(s),
      });
      created++;
    }
    // Ensure the parties exist as customers/suppliers so receipt/payment
    // allocation and master-push keep working alongside voucher drafts.
    for (const name of ["Sharma Traders", "Gupta Enterprises"]) {
      if (!(await findCustomerByName(userId, name))) {
        try {
          await createCustomer(userId, name);
        } catch { /* race — ignore */ }
      }
    }
    if (!(await findSupplierByName(userId, "Reliance Distributors"))) {
      await createSupplier(userId, "Reliance Distributors");
    }
    res.status(201).json({ created, skipped });
  } catch (err) {
    console.error("[push-data][vouchers/seed] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

/**
 * POST /push-data/vouchers/push — queue drafts as PUSH_VOUCHERS.
 * The connector polls GET /commands/pending and writes to Tally locally.
 */
router.post("/push-data/vouchers/push", requireAuth, async (req: Request, res: Response) => {
  const parsed = pushVouchersSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
    return;
  }
  try {
    const userId = req.user!.userId;
    const { connectorId, companyId, voucherIds } = parsed.data;

    // Resolve connector (new-spec first, legacy tc_* fallback).
    let target: { kind: "whizunik"; connectorId: string } | { kind: "legacy"; rowId: string; connectorId: string } | null = null;
    const conn = await getWConnectorByPublicId(connectorId);
    if (conn && conn.tenant_id === userId && conn.status === "active") {
      target = { kind: "whizunik", connectorId: conn.connector_id as string };
    } else {
      try {
        const legacy = await getLegacyConnector(connectorId);
        if (legacy && legacy.user_id === userId && legacy.status !== "REVOKED") {
          target = { kind: "legacy", rowId: legacy.id as string, connectorId: legacy.connector_id as string };
        }
      } catch { /* legacy table may not exist */ }
    }
    if (!target) {
      sendWzError(res, "INVALID_COMPANY", "Connector not found for this account");
      return;
    }

    // Resolve company (new-spec or legacy tally_companies).
    let companyName = "";
    let tallyGuid: string | null = null;
    const wco = await getWCompany(companyId);
    if (wco) {
      companyName = (wco.name as string) ?? "";
      tallyGuid = (wco.tally_guid as string) ?? null;
    } else {
      try {
        const legacyCo = await getLegacyCompany(userId, companyId);
        if (!legacyCo) {
          sendWzError(res, "INVALID_COMPANY", "Company not found for this account");
          return;
        }
        companyName = (legacyCo.tally_company_name as string) ?? "";
        tallyGuid = (legacyCo.tally_company_guid as string) ?? null;
      } catch {
        sendWzError(res, "INVALID_COMPANY", "Company not found for this account");
        return;
      }
    }

    const all = await listVouchers(userId);
    const wanted = new Set(voucherIds);
    const drafts = all.filter((r) => r.direction === "outbound" && wanted.has(r.id as string));
    if (drafts.length === 0) {
      sendWzError(res, "INVALID_PAYLOAD", "No matching voucher drafts for this account");
      return;
    }
    const locked = drafts.filter((d) => (d.push_status ?? "DRAFT") !== "DRAFT");
    if (locked.length > 0) {
      sendWzError(res, "INVALID_PAYLOAD", `${locked.length} voucher(s) already queued — only DRAFTs can be pushed`);
      return;
    }

    const vouchers = drafts.map((d) => {
      const vdate = String(d.voucher_date || "").slice(0, 10);
      return {
        invoiceId: d.id,
        invoiceNumber: d.voucher_number,
        partyName: d.party_ledger,
        amount: Number(d.amount),
        issueDate: vdate,
        tallyDate: vdate.replace(/-/g, ""),
        voucherType: CONNECTOR_VOUCHER_LABEL[String(d.voucher_type)] ?? "Sales",
        tallyVoucherType: d.voucher_type,
        narration: d.narration ?? "",
      };
    });

    const id = `cmd_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
    const payload = JSON.stringify({ companyId, companyName, tallyCompanyGuid: tallyGuid, vouchers });
    if (target.kind === "whizunik") {
      await createWCommand({ id, tenant_id: userId, connector_id: target.connectorId, command: "PUSH_VOUCHERS", payload });
    } else {
      await createSyncCommand({ id, user_id: userId, connector_id: target.rowId, command: "PUSH_VOUCHERS", payload });
    }
    for (const d of drafts) {
      await dbUpdate(d.pk, d.sk, { push_status: "QUEUED", push_command_id: id });
    }

    res.status(201).json({
      id,
      connectorId: target.connectorId,
      command: "PUSH_VOUCHERS",
      status: "PENDING",
      createdAt: new Date().toISOString(),
      voucherCount: vouchers.length,
      vouchers,
    });
  } catch (err) {
    console.error("[push-data][vouchers/push] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

// ---------------------------------------------------------------------------
// Stock / groups / ledgers (Tally masters authored in the cloud)
// ---------------------------------------------------------------------------

const LEDGER_TYPE_FOR_KIND: Record<string, string> = {
  group: "GROUP",
  ledger: "LEDGER",
  stock_group: "STOCK_GROUP",
  stock_category: "STOCK_CATEGORY",
  unit: "UNIT",
  godown: "GODOWN",
  voucher_type: "VOUCHER_TYPE",
};

/** GET /push-data/stock — stock items (products) + groups/ledgers/units/godowns. */
router.get("/push-data/stock", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { kind } = req.query as Record<string, string | undefined>;
    const [products, ledgers, customers, suppliers] = await Promise.all([
      listProducts(userId, 500),
      dbQueryPk(userPk(userId), "LEDGER#"),
      listCustomers(userId).catch(() => []),
      listSuppliers(userId).catch(() => []),
    ]);
    let items = products.map((p) => ({
      kind: "stock_item",
      id: p.id,
      name: p.name,
      group: (p.group_name as string) ?? null,
      category: (p.category as string) ?? null,
      unit: (p.base_unit as string) ?? null,
      description: (p.description as string) ?? null,
      createdAt: p.created_at,
    }));
    let masters = ledgers.map((l) => ({
      kind: Object.keys(LEDGER_TYPE_FOR_KIND).find((k) => LEDGER_TYPE_FOR_KIND[k] === l.ledger_type) ?? "ledger",
      id: l.id,
      name: l.name,
      parent: (l.parent_group as string) ?? null,
      ledgerType: l.ledger_type ?? null,
      openingBalance: Number(l.opening_balance ?? 0),
      createdAt: l.created_at,
    }));
    if (kind) {
      items = items.filter((i) => i.kind === kind);
      masters = masters.filter((m) => m.kind === kind);
    }
    res.status(200).json({
      stockItems: items,
      masters,
      counts: {
        customers: customers.length,
        suppliers: suppliers.length,
        stockItems: items.length,
        masters: masters.length,
      },
    });
  } catch (err) {
    console.error("[push-data][stock/list] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

/** POST /push-data/stock — create a stock item, group, ledger, unit or godown. */
router.post("/push-data/stock", requireAuth, async (req: Request, res: Response) => {
  const parsed = stockSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
    return;
  }
  try {
    const userId = req.user!.userId;
    const input = parsed.data;
    if (input.kind === "stock_item") {
      const existing = await findProductByName(userId, input.name);
      if (existing) {
        sendWzError(res, "INVALID_PAYLOAD", `Stock item "${input.name}" already exists`);
        return;
      }
      const created = await createProduct(userId, {
        name: input.name,
        group_name: input.parent?.trim() || null,
        category: input.description?.trim() || null,
        base_unit: input.unit?.trim() || null,
        description: input.description?.trim() || null,
      });
      res.status(201).json({ item: { kind: "stock_item", id: created.id, name: created.name } });
      return;
    }
    const ledgerType = LEDGER_TYPE_FOR_KIND[input.kind] ?? "LEDGER";
    const existing = await findLedger(userId, "__push__", input.name).catch(() => undefined);
    // findLedger is company-scoped; scan all companies for a name clash instead.
    const allLedgers = await dbQueryPk(userPk(userId), "LEDGER#");
    if (allLedgers.some((l) => String(l.name || "").toLowerCase() === input.name.toLowerCase() && l.ledger_type === ledgerType)) {
      sendWzError(res, "INVALID_PAYLOAD", `"${input.name}" already exists as ${input.kind}`);
      return;
    }
    void existing;
    const created = await createLedger({
      user_id: userId,
      company_id: "__push__",
      name: input.name,
      parent_group: input.parent?.trim() || null,
      ledger_type: ledgerType,
      opening_balance: input.openingBalance ?? 0,
    });
    res.status(201).json({ item: { kind: input.kind, id: created.id, name: created.name } });
  } catch (err) {
    console.error("[push-data][stock/create] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

/** DELETE /push-data/stock/:kind/:id — delete a cloud-authored master. */
router.delete("/push-data/stock/:kind/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { kind, id } = req.params as { kind: string; id: string };
    if (kind === "stock_item") {
      const { getProduct } = await import("../../../db/storesCore.js");
      const row = await getProduct(userId, id);
      if (!row) {
        sendWzError(res, "INVALID_PAYLOAD", "Stock item not found for this account");
        return;
      }
      await dbDelete(row.pk, row.sk);
      res.status(200).json({ success: true });
      return;
    }
    if (!Object.keys(LEDGER_TYPE_FOR_KIND).includes(kind)) {
      sendWzError(res, "INVALID_PAYLOAD", `Unknown stock kind "${kind}"`);
      return;
    }
    const rows = await dbQueryPk(userPk(userId), "LEDGER#");
    const row = rows.find((r) => r.id === id);
    if (!row) {
      sendWzError(res, "INVALID_PAYLOAD", "Master record not found for this account");
      return;
    }
    await dbDelete(row.pk, row.sk);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("[push-data][stock/delete] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

/** POST /push-data/stock/seed — sample groups, ledgers, units, godowns, items. */
router.post("/push-data/stock/seed", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    let created = 0;
    let skipped = 0;

    const ledgerSeeds: Array<{ kind: keyof typeof LEDGER_TYPE_FOR_KIND; name: string; parent?: string; opening?: number }> = [
      { kind: "group", name: "Sundry Debtors", parent: "Current Assets" },
      { kind: "group", name: "Sundry Creditors", parent: "Current Liabilities" },
      { kind: "group", name: "Sales Accounts", parent: "Income" },
      { kind: "group", name: "Purchase Accounts", parent: "Expenses" },
      { kind: "ledger", name: "Cash in Hand", parent: "Cash-in-Hand", opening: 25000 },
      { kind: "ledger", name: "HDFC Current Account", parent: "Bank Accounts", opening: 150000 },
      { kind: "ledger", name: "GST Output CGST", parent: "Duties & Taxes" },
      { kind: "ledger", name: "Sharma Traders", parent: "Sundry Debtors", opening: 11800 },
      { kind: "stock_group", name: "Electronics", parent: "Primary" },
      { kind: "stock_group", name: "FMCG", parent: "Primary" },
      { kind: "stock_category", name: "Mobile Phones", parent: "Electronics" },
      { kind: "stock_category", name: "Grocery", parent: "FMCG" },
      { kind: "unit", name: "PCS" },
      { kind: "unit", name: "BOX" },
      { kind: "unit", name: "KG" },
      { kind: "godown", name: "Main Warehouse" },
      { kind: "godown", name: "Mumbai Depot" },
    ];
    const existingLedgers = await dbQueryPk(userPk(userId), "LEDGER#");
    const ledgerKey = (n: string, t: string) => `${t}::${n.toLowerCase()}`;
    const seen = new Set(existingLedgers.map((l) => ledgerKey(String(l.name || ""), String(l.ledger_type || ""))));
    for (const s of ledgerSeeds) {
      const lt = LEDGER_TYPE_FOR_KIND[s.kind];
      if (seen.has(ledgerKey(s.name, lt))) {
        skipped++;
        continue;
      }
      await createLedger({
        user_id: userId,
        company_id: "__push__",
        name: s.name,
        parent_group: s.parent ?? null,
        ledger_type: lt,
        opening_balance: s.opening ?? 0,
      });
      seen.add(ledgerKey(s.name, lt));
      created++;
    }

    const itemSeeds = [
      { name: "Samsung Galaxy M35", group_name: "Electronics", category: "Mobile Phones", base_unit: "PCS", description: "6GB RAM, 128GB storage" },
      { name: "Basmati Rice 5kg", group_name: "FMCG", category: "Grocery", base_unit: "BOX", description: "Premium long-grain rice" },
      { name: "Tata Salt 1kg", group_name: "FMCG", category: "Grocery", base_unit: "KG", description: "Iodised vacuum salt" },
    ];
    for (const s of itemSeeds) {
      if (await findProductByName(userId, s.name)) {
        skipped++;
        continue;
      }
      await createProduct(userId, s);
      created++;
    }
    res.status(201).json({ created, skipped });
  } catch (err) {
    console.error("[push-data][stock/seed] failed:", err);
    sendWzError(res, "SERVER_ERROR", "An internal error occurred");
  }
});

export default router;
