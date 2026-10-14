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
  const statusFilter =
    typeof status === "string" && status.trim().length > 0 ? (status as string) : undefined;
  const rows = await listInvoices(req.user!.userId, {
    customer_id: customer_id as string | undefined,
    status: statusFilter,
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
  // Intra-file dedupe: same customer + normalized number twice in one upload
  // must import once and report the rest as skipped (exact, no duplicates).
  const seenInFile = new Set<string>();
  const normNum = (v: unknown) => String(v ?? "").trim().toLowerCase();

  try {
    for (const inv of invoiceList) {
      if (!inv.customer_id || !inv.invoice_number || !inv.issue_date || !inv.due_date || !inv.amount) {
        errors.push({
          invoice_number: inv.invoice_number || "unknown",
          error: "Missing required fields",
        });
        continue;
      }

      const cleanNumber = String(inv.invoice_number).trim();
      const fileKey = `${String(inv.customer_id)}|${normNum(cleanNumber)}`;
      if (seenInFile.has(fileKey)) {
        skipped.push({
          invoice_number: cleanNumber,
          customer_id: inv.customer_id,
          reason: "Duplicate in this file — already imported above",
        });
        continue;
      }
      seenInFile.add(fileKey);

      // Check if invoice already exists for this customer (trimmed, case-insensitive)
      const existing = await findInvoiceByNumber(userId, inv.customer_id, cleanNumber);

      if (existing) {
        skipped.push({
          invoice_number: cleanNumber,
          customer_id: inv.customer_id,
          reason: "Already exists in the platform",
        });
        continue;
      }

      const row = await createInvoice(userId, {
        customer_id: inv.customer_id,
        invoice_number: cleanNumber,
        issue_date: inv.issue_date,
        due_date: inv.due_date,
        amount: inv.amount,
        balance: inv.amount,
        status: "open",
        // Phase 4 single-line detail (optional; stored verbatim when supplied
        // so /invoices/push can build the full PUSH_VOUCHERS command).
        quantity: inv.quantity ?? inv.qty ?? null,
        unit: inv.unit ?? inv.base_unit ?? null,
        unit_price: inv.unit_price ?? inv.unitPrice ?? null,
        gst_rate: inv.gst_rate ?? inv.gstRate ?? null,
        sku_id: inv.sku_id ?? inv.skuId ?? null,
        sku_code: inv.sku_code ?? inv.skuCode ?? null,
        grand_total: inv.grand_total ?? inv.grandTotal ?? inv.amount,
        version: inv.version ?? 1,
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
    // Tidy, exact order: due date first, then invoice number (case-insensitive).
    const d = String(a.due_date || "").localeCompare(String(b.due_date || ""));
    if (d !== 0) return d;
    return String(a.invoice_number || "").toLowerCase().localeCompare(String(b.invoice_number || "").toLowerCase());
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
        // Phase 4 Update §2.5: both references side by side — WhizUnik
        // invoice number (commercial) + Tally voucher number (accounting)
        // + Tally internal reference + sync state.
        whizunik_invoice_number: i.invoice_number,
        tally_voucher_number: i.tally_voucher_number ?? null,
        tally_internal_reference: i.tally_reference ?? null,
        tally_company_name: i.tally_company_name ?? null,
        sync_status: i.sync_status ?? null,
        synced_at: i.synced_at ?? null,
        connector_id: i.connector_id ?? null,
        push_command_id: i.push_command_id ?? null,
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
