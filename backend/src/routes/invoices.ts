import { Router, Request, Response } from "express";
import {
  listInvoices,
  findInvoiceByNumber,
  createInvoice,
  getInvoice,
  deleteInvoice,
  getCustomer,
  listAllocations,
  listPayments,
} from "../db/storesCore.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

// List invoices
router.get("/", async (req: Request, res: Response) => {
  const { customer_id, status, due_date_lte } = req.query;
  const rows = await listInvoices(req.user!.userId, {
    customer_id: customer_id as string | undefined,
    status: status === "open" || status === "closed" ? (status as string) : undefined,
    due_date_lte: due_date_lte as string | undefined,
  });
  res.json({ invoices: rows });
});

// Create invoice(s) — bulk import
// Returns two lists:
//   imported — invoices that were successfully created
//   skipped  — invoices that already exist for this customer (same invoice_number)
router.post("/", async (req: Request, res: Response) => {
  const { invoices: invoiceList } = req.body;

  if (!Array.isArray(invoiceList) || invoiceList.length === 0) {
    res.status(400).json({ error: "Invoices array is required" });
    return;
  }

  const userId = req.user!.userId;
  const imported: any[] = [];
  const skipped: Array<{ invoice_number: string; customer_id: string; reason: string }> = [];
  const errors: Array<{ invoice_number: string; error: string }> = [];

  try {
    for (const inv of invoiceList) {
      if (!inv.customer_id || !inv.invoice_number || !inv.issue_date || !inv.due_date || !inv.amount) {
        errors.push({
          invoice_number: inv.invoice_number || "unknown",
          error: "Missing required fields",
        });
        continue;
      }

      // Check if invoice already exists for this customer
      const existing = await findInvoiceByNumber(userId, inv.customer_id, inv.invoice_number);

      if (existing) {
        skipped.push({
          invoice_number: inv.invoice_number,
          customer_id: inv.customer_id,
          reason: "Already exists in the platform",
        });
        continue;
      }

      const row = await createInvoice(userId, {
        customer_id: inv.customer_id,
        invoice_number: inv.invoice_number,
        issue_date: inv.issue_date,
        due_date: inv.due_date,
        amount: inv.amount,
        balance: inv.amount,
        status: "open",
      });
      imported.push(row);
    }

    res.status(201).json({
      imported,
      skipped,
      errors,
      importedCount: imported.length,
      skippedCount: skipped.length,
      errorCount: errors.length,
    });
  } catch (error: any) {
    console.error("Create invoices error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Export invoices with payment and allocation details, filterable by customer and status
router.get("/export", async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { customer_id, status } = req.query;

  let invoices = await listInvoices(userId, {
    customer_id: customer_id as string | undefined,
  });
  if (status === "open" || status === "closed") {
    invoices = invoices.filter((i) => i.status === status);
  }

  const [allocs, payments] = await Promise.all([
    listAllocations(userId),
    listPayments(userId),
  ]);
  const payById = new Map(payments.map((p) => [p.id as string, p]));
  const allocsByInvoice = new Map<string, any[]>();
  for (const a of allocs) {
    const key = a.invoice_id as string;
    if (!allocsByInvoice.has(key)) allocsByInvoice.set(key, []);
    allocsByInvoice.get(key)!.push(a);
  }

  const rows: any[] = [];
  // Cache customer names
  const customerNames = new Map<string, string>();
  async function customerName(cid: string): Promise<string | null> {
    if (customerNames.has(cid)) return customerNames.get(cid)!;
    const c = await getCustomer(userId, cid);
    const name = (c?.name as string) || null;
    customerNames.set(cid, name as string);
    return name;
  }

  const sorted = [...invoices].sort((a, b) => {
    const ca = String(a.closed_date || "");
    const cb = String(b.closed_date || "");
    if (cb !== ca) return cb.localeCompare(ca);
    return String(a.invoice_number || "").localeCompare(String(b.invoice_number || ""));
  });

  for (const i of sorted) {
    const name = await customerName(i.customer_id as string);
    const related = allocsByInvoice.get(i.id as string) || [null];
    for (const pa of related) {
      const p = pa ? payById.get(pa.payment_id as string) : undefined;
      rows.push({
        invoice_number: i.invoice_number,
        issue_date: i.issue_date,
        due_date: i.due_date,
        amount: i.amount,
        balance: i.balance,
        status: i.status,
        closed_date: i.closed_date ?? null,
        payment_days: i.payment_days ?? null,
        late_payment_days: i.late_payment_days ?? null,
        customer_name: name,
        amount_applied: pa?.amount_applied ?? null,
        applied_date: pa?.applied_date ?? null,
        closed_invoice: pa?.closed_invoice ?? null,
        payment_date: p?.payment_date ?? null,
        payment_amount: p?.amount ?? null,
        payment_note: p?.note ?? null,
      });
    }
  }

  res.json({ rows });
});

// Delete invoice
router.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const invoice = await getInvoice(req.user!.userId, id);

  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  await deleteInvoice(req.user!.userId, id);
  res.json({ success: true });
});

export default router;
