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
router.post("/", (req: Request, res: Response) => {
  const { invoices: invoiceList } = req.body;

  if (!Array.isArray(invoiceList) || invoiceList.length === 0) {
    res.status(400).json({ error: "Invoices array is required" });
    return;
  }

  const created: any[] = [];

  try {
    const tx = db.transaction(() => {
      for (const inv of invoiceList) {
        if (!inv.customer_id || !inv.invoice_number || !inv.issue_date || !inv.due_date || !inv.amount) {
          throw new Error(`Missing required fields for invoice: ${inv.invoice_number || "unknown"}`);
        }
        const id = uuidv4();
        db.prepare(
          `INSERT INTO invoices (id, user_id, customer_id, invoice_number, issue_date, due_date, amount, balance, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`
        ).run(id, req.user!.userId, inv.customer_id, inv.invoice_number, inv.issue_date, inv.due_date, inv.amount);

        const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
        created.push(row);
      }
    });

    tx();
    res.status(201).json({ invoices: created, count: created.length });
  } catch (error: any) {
    const msg = error?.message || String(error);
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      res.status(409).json({ error: "Duplicate invoice number for this customer" });
      return;
    }
    console.error("Create invoices error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
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
