import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

// List payments
router.get("/", (req: Request, res: Response) => {
  const rows = db
    .prepare("SELECT * FROM payments WHERE user_id = ? ORDER BY payment_date DESC")
    .all(req.user!.userId);

  res.json({ payments: rows });
});

// Get customer balance (remaining from previous payments)
router.get("/balance/:customerId", (req: Request, res: Response) => {
  const { customerId } = req.params;

  const rows = db
    .prepare("SELECT remaining FROM payments WHERE user_id = ? AND customer_id = ? AND remaining > 0")
    .all(req.user!.userId, customerId) as { remaining: number }[];

  const total = rows.reduce((sum, p) => sum + Number(p.remaining), 0);
  res.json({ remaining: total });
});

// Apply payment — the main reconciliation action
router.post("/apply", (req: Request, res: Response) => {
  const {
    customer_id,
    payment_date,
    amount,
    note,
    selected_invoice_ids,
    use_balance = false,
  } = req.body;

  if (!customer_id || !payment_date || amount === undefined || amount === null || !Array.isArray(selected_invoice_ids)) {
    res.status(400).json({ error: "Missing required fields: customer_id, payment_date, amount, selected_invoice_ids" });
    return;
  }

  const userId = req.user!.userId;
  const paymentAmount = Number(amount);
  if (!isFinite(paymentAmount) || paymentAmount < 0) {
    res.status(400).json({ error: "Invalid payment amount" });
    return;
  }

  try {
    let result: any = {};

    const tx = db.transaction(() => {
      // 1. Calculate available amount
      let availableAmount = paymentAmount;
      let previousRemaining = 0;

      if (use_balance) {
        const balanceRows = db
          .prepare("SELECT remaining FROM payments WHERE user_id = ? AND customer_id = ? AND remaining > 0")
          .all(userId, customer_id) as { remaining: number }[];
        previousRemaining = balanceRows.reduce((sum, p) => sum + Number(p.remaining), 0);
        availableAmount += previousRemaining;

        // Consume all previous remaining balances
        db.prepare(
          "UPDATE payments SET remaining = 0 WHERE user_id = ? AND customer_id = ? AND remaining > 0"
        ).run(userId, customer_id);
      }

      // 2. Create payment record
      const paymentId = uuidv4();
      let remainingAmount = availableAmount;
      let totalApplied = 0;
      const allocations: any[] = [];

      // 3. Allocate to selected invoices (if any)
      if (selected_invoice_ids.length > 0) {
        const placeholders = selected_invoice_ids.map(() => "?").join(",");
        const invoiceRows = db
          .prepare(
            `SELECT * FROM invoices WHERE id IN (${placeholders}) AND user_id = ? AND customer_id = ? AND status = 'open' ORDER BY due_date`
          )
          .all(...selected_invoice_ids, userId, customer_id) as any[];

        if (invoiceRows.length === 0) {
          throw new Error("No valid open invoices found");
        }

        for (const inv of invoiceRows) {
          if (remainingAmount <= 0) break;

          const balance = Number(inv.balance);
          const apply = Math.min(remainingAmount, balance);
          const newBalance = +(balance - apply).toFixed(2);
          const closes = newBalance <= 0;

          // Update invoice
          let updateSql = "UPDATE invoices SET balance = ?";
          const updateParams: any[] = [newBalance];

          if (closes) {
            updateSql += ", status = 'closed', closed_date = ?, payment_days = ?, late_payment_days = ?";
            const paymentDays = daysBetween(inv.issue_date, payment_date);
            const lateDays = Math.max(0, daysBetween(inv.due_date, payment_date));
            updateParams.push(payment_date, paymentDays, lateDays);
          }

          updateSql += " WHERE id = ?";
          updateParams.push(inv.id);
          db.prepare(updateSql).run(...updateParams);

          // Create allocation
          const allocId = uuidv4();
          db.prepare(
            `INSERT INTO payment_allocations (id, user_id, payment_id, invoice_id, amount_applied, applied_date, closed_invoice)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(allocId, userId, paymentId, inv.id, +apply.toFixed(2), payment_date, closes ? 1 : 0);

          allocations.push({
            id: allocId,
            invoice_id: inv.id,
            invoice_number: inv.invoice_number,
            amount_applied: +apply.toFixed(2),
            closed_invoice: closes,
          });

          totalApplied += apply;
          remainingAmount = +(remainingAmount - apply).toFixed(2);
        }
      }

      // 4. Insert payment record
      db.prepare(
        `INSERT INTO payments (id, user_id, customer_id, payment_date, amount, applied_amount, remaining, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(paymentId, userId, customer_id, payment_date, paymentAmount, +totalApplied.toFixed(2), +remainingAmount.toFixed(2), note || null);

      result = {
        payment: {
          id: paymentId,
          customer_id,
          payment_date,
          amount: paymentAmount,
          applied_amount: +totalApplied.toFixed(2),
          remaining: +remainingAmount.toFixed(2),
          note: note || null,
        },
        allocations,
      };
    });

    tx();
    res.status(201).json(result);
  } catch (error: any) {
    console.error("Apply payment error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

function daysBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(ms / 86400000);
}

export default router;
