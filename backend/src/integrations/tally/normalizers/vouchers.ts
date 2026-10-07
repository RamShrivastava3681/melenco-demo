import {
  findCustomerByName,
  createCustomer,
  findSupplierByName,
  createSupplier,
  findInvoiceByNumber,
  createInvoice,
  updateInvoice,
  listInvoices,
  listPayments,
  createPayment,
  createAllocation,
} from "../../../db/storesCore.js";
import { findPurchaseInvoice, createPurchaseInvoice, createVoucher } from "../../../db/storesTally.js";
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
  normalize: (ctx: NormalizeContext) => Promise<NormalizedResult>;
}

function dataOf(ctx: NormalizeContext): Record<string, any> {
  return (ctx.record.data as Record<string, any>) ?? {};
}

/** Resolve or create the customer for a party-ledger name. */
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

async function upsertSupplier(userId: string, name: string): Promise<string> {
  const existing = await findSupplierByName(userId, name);
  if (existing) return existing.id as string;
  const created = await createSupplier(userId, name);
  return created.id as string;
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
    normalize: async (ctx) => {
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

      const customerId = await upsertCustomer(ctx.userId, party.trim());

      // Idempotent insert; updates balance/status if content changed
      const existing = await findInvoiceByNumber(ctx.userId, customerId, voucherNumber);

      if (existing) {
        // Only touch financials if the invoice is still open (never regress reconciled data)
        if (existing.status === "open") {
          await updateInvoice(ctx.userId, existing.id as string, {
            issue_date: issueDate,
            due_date: dueDate,
            amount,
            balance: amount,
          });
        }
        return { table: "invoices", recordId: existing.id as string };
      }

      const created = await createInvoice(ctx.userId, {
        customer_id: customerId,
        invoice_number: voucherNumber,
        issue_date: issueDate,
        due_date: dueDate,
        amount,
        balance: amount,
        status: "open",
      });
      return { table: "invoices", recordId: created.id as string };
    },
  },

  RECEIPT_VOUCHER: {
    table: "payments",
    normalize: async (ctx) => {
      const d = dataOf(ctx);
      const voucherNumber = requireVoucherNumber(ctx);
      const paymentDate = requireDate(ctx);
      const amount = requireAmount(ctx);
      const party = ctx.record.partyName || d.partyName;
      if (typeof party !== "string" || !party.trim()) {
        throw new ApiError("TALLY_DATA_INVALID", "Receipt voucher is missing partyName");
      }

      const customerId = await upsertCustomer(ctx.userId, party.trim());

      // Idempotency beyond source records: same customer + date + amount + note tag
      const note = `Tally ${ctx.record.voucherType || "Receipt"} ${voucherNumber}`;
      const existingPayment = (await listPayments(ctx.userId)).find(
        (p) =>
          p.customer_id === customerId &&
          p.payment_date === paymentDate &&
          Number(p.amount) === Number(amount) &&
          p.note === note
      );
      if (existingPayment) {
        return { table: "payments", recordId: existingPayment.id as string };
      }

      // FIFO allocation against open invoices (mirrors existing payments logic)
      const openInvoices = (await listInvoices(ctx.userId, { customer_id: customerId, status: "open" }))
        .filter((i) => Number(i.balance) !== 0)
        .sort((a, b) => String(a.due_date || "").localeCompare(String(b.due_date || "")));

      let remaining = amount;
      const allocations: Array<{ invoiceId: string; applied: number; closes: boolean }> = [];

      for (const inv of openInvoices) {
        if (remaining <= 0.004) break;
        const balance = Number(inv.balance);
        const applied = Math.min(remaining, balance);
        const newBalance = +(balance - applied).toFixed(2);
        const closes = newBalance <= 0.004;

        await updateInvoice(ctx.userId, inv.id as string, {
          balance: newBalance,
          status: closes ? "closed" : "open",
          closed_date: closes ? paymentDate : null,
        });

        allocations.push({ invoiceId: inv.id as string, applied: +applied.toFixed(2), closes });
        remaining = +(remaining - applied).toFixed(2);
      }

      const totalApplied = +allocations.reduce((s, a) => s + a.applied, 0).toFixed(2);

      const payment = await createPayment(ctx.userId, {
        customer_id: customerId,
        payment_date: paymentDate,
        amount,
        applied_amount: totalApplied,
        remaining,
        note,
      });

      for (const a of allocations) {
        await createAllocation(ctx.userId, {
          payment_id: payment.id,
          invoice_id: a.invoiceId,
          amount_applied: a.applied,
          applied_date: paymentDate,
          closed_invoice: a.closes ? 1 : 0,
        });
      }

      return { table: "payments", recordId: payment.id as string };
    },
  },

  PURCHASE_VOUCHER: {
    table: "purchase_invoices",
    normalize: async (ctx) => {
      const d = dataOf(ctx);
      const voucherNumber = requireVoucherNumber(ctx);
      const issueDate = requireDate(ctx);
      const amount = requireAmount(ctx);
      const party = ctx.record.partyName || d.partyName;
      if (typeof party !== "string" || !party.trim()) {
        throw new ApiError("TALLY_DATA_INVALID", "Purchase voucher is missing partyName");
      }

      const supplierId = await upsertSupplier(ctx.userId, party.trim());
      const dueDate =
        typeof d.dueDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(d.dueDate) ? d.dueDate.slice(0, 10) : null;

      const existing = await findPurchaseInvoice(ctx.userId, supplierId, voucherNumber);

      if (existing) return { table: "purchase_invoices", recordId: existing.id as string };

      const created = await createPurchaseInvoice({
        user_id: ctx.userId,
        supplier_id: supplierId,
        invoice_number: voucherNumber,
        issue_date: issueDate,
        due_date: dueDate,
        amount,
      });
      return { table: "purchase_invoices", recordId: created.id as string };
    },
  },

  // Everything else (PAYMENT/JOURNAL/CONTRA/DEBIT_NOTE/CREDIT_NOTE/ORDERS/NOTES/STOCK_JOURNAL)
  // preserves the original voucher in a generic store — queryable, never lost.
  __DEFAULT__: {
    table: "tally_vouchers",
    normalize: async (ctx) => {
      const d = dataOf(ctx);
      const voucherNumber =
        (typeof ctx.record.voucherNumber === "string" && ctx.record.voucherNumber.trim()) || null;
      const voucherDate = requireDate(ctx);
      const amount = requireAmount(ctx);

      const created = await createVoucher({
        user_id: ctx.userId,
        company_id: ctx.companyId,
        voucher_type: ctx.entityType,
        voucher_number: voucherNumber,
        voucher_date: voucherDate,
        party_ledger:
          (typeof ctx.record.partyName === "string" && ctx.record.partyName) || (d.partyName as string) || null,
        amount,
        narrative: (d.narration as string) || null,
        raw_json: JSON.stringify(ctx.record.data ?? ctx.record),
      });
      return { table: "tally_vouchers", recordId: created.id as string };
    },
  },
};

/** Dispatch helper used by the registry (falls back to generic store). */
export async function normalizeVoucher(ctx: NormalizeContext): Promise<NormalizedResult> {
  const target = VOUCHER_TARGETS[ctx.entityType] ?? VOUCHER_TARGETS.__DEFAULT__;
  return target.normalize(ctx);
}
