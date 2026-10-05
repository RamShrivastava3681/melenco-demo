import db from "../../../db/index.js";
import { v4 as uuidv4 } from "uuid";
import { ApiError } from "../errors.js";
import type { NormalizeContext, NormalizedResult } from "./registry.js";

/**
 * Voucher normalizers.
 *
 * Mappings:
 *   SALES_VOUCHER    → invoices (existing table, scoped by user_id)
 *   RECEIPT_VOUCHER  → payments + payment_allocations (FIFO against open invoices)
 *   PURCHASE_VOUCHER → purchase_invoices
 *   all others       → tally_vouchers (generic store, preserves everything)
 */

interface VoucherTarget {
  table: string;
  normalize: (ctx: NormalizeContext) => NormalizedResult;
}

function dataOf(ctx: NormalizeContext): Record<string, any> {
  return (ctx.record.data as Record<string, any>) ?? {};
}

/** Resolve or create the customer for a party-ledger name. */
function upsertCustomer(userId: string, name: string): string {
  const existing = db
    .prepare(`SELECT id FROM customers WHERE user_id = ? AND LOWER(name) = LOWER(?)`)
    .get(userId, name) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = uuidv4();
  db.prepare(`INSERT OR IGNORE INTO customers (id, user_id, name) VALUES (?, ?, ?)`).run(id, userId, name);
  const row = db
    .prepare(`SELECT id FROM customers WHERE user_id = ? AND LOWER(name) = LOWER(?)`)
    .get(userId, name) as { id: string };
  return row.id;
}

function upsertSupplier(userId: string, name: string): string {
  const existing = db
    .prepare(`SELECT id FROM suppliers WHERE user_id = ? AND LOWER(name) = LOWER(?)`)
    .get(userId, name) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = uuidv4();
  db.prepare(`INSERT OR IGNORE INTO suppliers (id, user_id, name) VALUES (?, ?, ?)`).run(id, userId, name);
  const row = db
    .prepare(`SELECT id FROM suppliers WHERE user_id = ? AND LOWER(name) = LOWER(?)`)
    .get(userId, name) as { id: string };
  return row.id;
}

/** Valid ISO-ish date guard. */
function requireDate(ctx: NormalizeContext, field = "voucherDate"): string {
  const raw = (ctx.record as any)[field] ?? dataOf(ctx)[field];
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    throw new ApiError("TALLY_DATA_INVALID", `Voucher is missing a valid ${field} (YYYY-MM-DD)`);
  }
  return raw.slice(0, 10);
}

function requireAmount(ctx: NormalizeContext): number {
  const d = dataOf(ctx);
  const raw = ctx.record.amount ?? d.amount ?? d.totalAmount;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new ApiError("TALLY_DATA_INVALID", "Voucher is missing a valid amount");
  }
  return n;
}

function requireVoucherNumber(ctx: NormalizeContext): string {
  const raw = ctx.record.voucherNumber ?? dataOf(ctx).voucherNumber;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ApiError("TALLY_DATA_INVALID", "Voucher is missing voucherNumber");
  }
  return raw.trim();
}

export const VOUCHER_TARGETS: Record<string, VoucherTarget> = {
  SALES_VOUCHER: {
    table: "invoices",
    normalize: (ctx) => {
      const d = dataOf(ctx);
      const voucherNumber = requireVoucherNumber(ctx);
      const issueDate = requireDate(ctx);
      const amount = requireAmount(ctx);
      const party = ctx.record.partyName || d.partyName;
      if (typeof party !== "string" || !party.trim()) {
        throw new ApiError("TALLY_DATA_INVALID", "Sales voucher is missing partyName");
      }

      const dueDate =
        typeof d.dueDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(d.dueDate)
          ? d.dueDate.slice(0, 10)
          : issueDate; // conservative default: due on issue

      const customerId = upsertCustomer(ctx.userId, party.trim());

      // Idempotent insert; updates balance/status if content changed
      const existing = db
        .prepare(
          `SELECT id, status, balance FROM invoices WHERE user_id = ? AND customer_id = ? AND invoice_number = ?`
        )
        .get(ctx.userId, customerId, voucherNumber) as
        | { id: string; status: string; balance: number }
        | undefined;

      if (existing) {
        // Only touch financials if the invoice is still open (never regress reconciled data)
        if (existing.status === "open") {
          db.prepare(
            `UPDATE invoices SET issue_date = ?, due_date = ?, amount = ?, balance = ? WHERE id = ?`
          ).run(issueDate, dueDate, amount, amount, existing.id);
        }
        return { table: "invoices", recordId: existing.id };
      }

      const id = uuidv4();
      db.prepare(
        `INSERT INTO invoices (id, user_id, customer_id, invoice_number, issue_date, due_date, amount, balance, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`
      ).run(id, ctx.userId, customerId, voucherNumber, issueDate, dueDate, amount, amount);
      return { table: "invoices", recordId: id };
    },
  },

  RECEIPT_VOUCHER: {
    table: "payments",
    normalize: (ctx) => {
      const d = dataOf(ctx);
      const voucherNumber = requireVoucherNumber(ctx);
      const paymentDate = requireDate(ctx);
      const amount = requireAmount(ctx);
      const party = ctx.record.partyName || d.partyName;
      if (typeof party !== "string" || !party.trim()) {
        throw new ApiError("TALLY_DATA_INVALID", "Receipt voucher is missing partyName");
      }

      const customerId = upsertCustomer(ctx.userId, party.trim());

      // Idempotency beyond source records: same customer + date + amount + note tag
      const note = `Tally ${ctx.record.voucherType || "Receipt"} ${voucherNumber}`;
      const existingPayment = db
        .prepare(
          `SELECT id FROM payments WHERE user_id = ? AND customer_id = ? AND payment_date = ? AND amount = ? AND note = ?`
        )
        .get(ctx.userId, customerId, paymentDate, amount, note) as { id: string } | undefined;
      if (existingPayment) {
        return { table: "payments", recordId: existingPayment.id };
      }

      // FIFO allocation against open invoices (mirrors existing payments logic)
      const openInvoices = db
        .prepare(
          `SELECT id, balance FROM invoices
           WHERE user_id = ? AND customer_id = ? AND status = 'open' AND balance != 0
           ORDER BY due_date`
        )
        .all(ctx.userId, customerId) as Array<{ id: string; balance: number }>;

      let remaining = amount;
      const paymentId = uuidv4();
      const allocations: Array<{ invoiceId: string; applied: number; closes: boolean }> = [];

      for (const inv of openInvoices) {
        if (remaining <= 0.004) break;
        const balance = Number(inv.balance);
        const applied = Math.min(remaining, balance);
        const newBalance = +(balance - applied).toFixed(2);
        const closes = newBalance <= 0.004;

        db.prepare(
          `UPDATE invoices SET balance = ?, status = ?, closed_date = ? WHERE id = ?`
        ).run(newBalance, closes ? "closed" : "open", closes ? paymentDate : null, inv.id);

        allocations.push({ invoiceId: inv.id, applied: +applied.toFixed(2), closes });
        remaining = +(remaining - applied).toFixed(2);
      }

      const totalApplied = +allocations.reduce((s, a) => s + a.applied, 0).toFixed(2);

      db.prepare(
        `INSERT INTO payments (id, user_id, customer_id, payment_date, amount, applied_amount, remaining, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(paymentId, ctx.userId, customerId, paymentDate, amount, totalApplied, remaining, note);

      for (const a of allocations) {
        db.prepare(
          `INSERT INTO payment_allocations (id, user_id, payment_id, invoice_id, amount_applied, applied_date, closed_invoice)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(uuidv4(), ctx.userId, paymentId, a.invoiceId, a.applied, paymentDate, a.closes ? 1 : 0);
      }

      return { table: "payments", recordId: paymentId };
    },
  },

  PURCHASE_VOUCHER: {
    table: "purchase_invoices",
    normalize: (ctx) => {
      const d = dataOf(ctx);
      const voucherNumber = requireVoucherNumber(ctx);
      const issueDate = requireDate(ctx);
      const amount = requireAmount(ctx);
      const party = ctx.record.partyName || d.partyName;
      if (typeof party !== "string" || !party.trim()) {
        throw new ApiError("TALLY_DATA_INVALID", "Purchase voucher is missing partyName");
      }

      const supplierId = upsertSupplier(ctx.userId, party.trim());
      const dueDate =
        typeof d.dueDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(d.dueDate) ? d.dueDate.slice(0, 10) : null;

      const existing = db
        .prepare(
          `SELECT id FROM purchase_invoices WHERE user_id = ? AND supplier_id = ? AND invoice_number = ?`
        )
        .get(ctx.userId, supplierId, voucherNumber) as { id: string } | undefined;

      if (existing) return { table: "purchase_invoices", recordId: existing.id };

      const id = uuidv4();
      db.prepare(
        `INSERT INTO purchase_invoices (id, user_id, supplier_id, invoice_number, issue_date, due_date, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, ctx.userId, supplierId, voucherNumber, issueDate, dueDate, amount);
      return { table: "purchase_invoices", recordId: id };
    },
  },

  // Everything else (PAYMENT/JOURNAL/CONTRA/DEBIT_NOTE/CREDIT_NOTE/ORDERS/NOTES/STOCK_JOURNAL)
  // preserves the original voucher in a generic store — queryable, never lost.
  __DEFAULT__: {
    table: "tally_vouchers",
    normalize: (ctx) => {
      const d = dataOf(ctx);
      const voucherNumber =
        (typeof ctx.record.voucherNumber === "string" && ctx.record.voucherNumber.trim()) || null;
      const voucherDate = requireDate(ctx);
      const amount = requireAmount(ctx);

      const id = uuidv4();
      db.prepare(
        `INSERT INTO tally_vouchers (id, user_id, company_id, voucher_type, voucher_number, voucher_date, party_ledger, amount, narrative, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        ctx.userId,
        ctx.companyId,
        ctx.entityType,
        voucherNumber,
        voucherDate,
        (typeof ctx.record.partyName === "string" && ctx.record.partyName) || (d.partyName as string) || null,
        amount,
        (d.narration as string) || null,
        JSON.stringify(ctx.record.data ?? ctx.record)
      );
      return { table: "tally_vouchers", recordId: id };
    },
  },
};

/** Dispatch helper used by the registry (falls back to generic store). */
export function normalizeVoucher(ctx: NormalizeContext): NormalizedResult {
  const target = VOUCHER_TARGETS[ctx.entityType] ?? VOUCHER_TARGETS.__DEFAULT__;
  return target.normalize(ctx);
}
