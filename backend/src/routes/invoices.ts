import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

// List invoices
router.get("/", (req: Request, res: Response) => {
  const { customer_id, status, due_date_lte } = req.query;
  let sql = "SELECT * FROM invoices WHERE user_id = ?";
  const params: any[] = [req.user!.userId];

  if (customer_id) {
    sql += " AND customer_id = ?";
    params.push(customer_id);
  }
  if (status && (status === "open" || status === "closed")) {
    sql += " AND status = ?";
    params.push(status);
  }
  if (due_date_lte) {
    sql += " AND due_date <= ?";
    params.push(due_date_lte);
  }
  sql += " ORDER BY due_date";

  const rows = db.prepare(sql).all(...params);
  res.json({ invoices: rows });
});

// Create invoice(s) — bulk import
// Returns two lists:
//   imported — invoices that were successfully created
//   skipped  — invoices that already exist for this customer (same invoice_number)
router.post("/", (req: Request, res: Response) => {
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
    const tx = db.transaction(() => {
      for (const inv of invoiceList) {
        if (!inv.customer_id || !inv.invoice_number || !inv.issue_date || !inv.due_date || !inv.amount) {
          errors.push({
            invoice_number: inv.invoice_number || "unknown",
            error: "Missing required fields",
          });
          continue;
        }

        // Check if invoice already exists for this customer
        const existing = db
          .prepare(
            "SELECT id FROM invoices WHERE user_id = ? AND customer_id = ? AND invoice_number = ?"
          )
          .get(userId, inv.customer_id, inv.invoice_number) as { id: string } | undefined;

        if (existing) {
          skipped.push({
            invoice_number: inv.invoice_number,
            customer_id: inv.customer_id,
            reason: "Already exists in the platform",
          });
          continue;
        }

        const id = uuidv4();
        db.prepare(
          `INSERT INTO invoices (id, user_id, customer_id, invoice_number, issue_date, due_date, amount, balance, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`
        ).run(id, userId, inv.customer_id, inv.invoice_number, inv.issue_date, inv.due_date, inv.amount, inv.amount);

        const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
        imported.push(row);
      }
    });

    tx();
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
router.get("/export", (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { customer_id, status } = req.query;

  let sql = `      SELECT
        i.invoice_number,
        i.issue_date,
        i.due_date,
        i.amount,
        i.balance,
        i.status,
        i.closed_date,
        i.payment_days,
        i.late_payment_days,
      c.name AS customer_name,
      pa.amount_applied,
      pa.applied_date,
      pa.closed_invoice,
      p.payment_date AS payment_date,
      p.amount AS payment_amount,
      p.note AS payment_note
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = ?
    LEFT JOIN payment_allocations pa ON pa.invoice_id = i.id AND pa.user_id = ?
    LEFT JOIN payments p ON p.id = pa.payment_id AND p.user_id = ?
    WHERE i.user_id = ?
  `;
  const params: any[] = [userId, userId, userId, userId];

  if (customer_id) {
    sql += ` AND i.customer_id = ?`;
    params.push(customer_id);
  }

  if (status === "open") {
    sql += ` AND i.status = 'open'`;
  } else if (status === "closed") {
    sql += ` AND i.status = 'closed'`;
  }
  // status = "all" or unset — export all statuses

  sql += ` ORDER BY i.closed_date DESC, i.invoice_number`;

  const rows = db.prepare(sql).all(...params);
  res.json({ rows });
});

// Delete invoice
router.delete("/:id", (req: Request, res: Response) => {
  const { id } = req.params;

  const invoice = db
    .prepare("SELECT id FROM invoices WHERE id = ? AND user_id = ?")
    .get(id, req.user!.userId);

  if (!invoice) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  db.prepare("DELETE FROM invoices WHERE id = ?").run(id);
  res.json({ success: true });
});

export default router;
