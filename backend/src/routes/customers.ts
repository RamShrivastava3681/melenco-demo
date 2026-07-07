import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// All routes require authentication
router.use(requireAuth);

// List customers with outstanding and remaining balances
router.get("/", (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const rows = db
    .prepare(
      `SELECT
         c.id,
         c.name,
         c.created_at,
         COALESCE(open_sum.total_balance, 0) AS outstanding_balance,
         COALESCE(rem_sum.total_remaining, 0) AS remaining_balance
       FROM customers c
       LEFT JOIN (
         SELECT customer_id, SUM(balance) AS total_balance
         FROM invoices
         WHERE user_id = ? AND status = 'open'
         GROUP BY customer_id
       ) open_sum ON open_sum.customer_id = c.id
       LEFT JOIN (
         SELECT customer_id, SUM(remaining) AS total_remaining
         FROM payments
         WHERE user_id = ? AND remaining > 0
         GROUP BY customer_id
       ) rem_sum ON rem_sum.customer_id = c.id
       WHERE c.user_id = ?
       ORDER BY c.name`
    )
    .all(userId, userId, userId);

  res.json({ customers: rows });
});

// Create customer
router.post("/", (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }

  try {
    const id = uuidv4();
    db.prepare(
      "INSERT INTO customers (id, user_id, name) VALUES (?, ?, ?)"
    ).run(id, req.user!.userId, name.trim());

    const customer = db
      .prepare("SELECT id, name, created_at FROM customers WHERE id = ?")
      .get(id);

    res.status(201).json({ customer });
  } catch (error: any) {
    const msg = error?.message || String(error);
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      res.status(409).json({ error: "Customer with this name already exists" });
      return;
    }
    console.error("Create customer error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Customer payment stats (avg, median, max, min pay days)
router.get("/stats", (req: Request, res: Response) => {
  const userId = req.user!.userId;

  // Get all closed invoices with payment_days for this user
  const rows = db
    .prepare(
      `SELECT customer_id, payment_days
       FROM invoices
       WHERE user_id = ? AND status = 'closed' AND payment_days IS NOT NULL
       ORDER BY customer_id, payment_days`
    )
    .all(userId) as { customer_id: string; payment_days: number }[];

  // Group by customer and compute stats
  const grouped: Record<string, number[]> = {};
  for (const row of rows) {
    if (!grouped[row.customer_id]) grouped[row.customer_id] = [];
    grouped[row.customer_id].push(Number(row.payment_days));
  }

  const stats: Record<string, { avg_pay_days: number | null; median_pay_days: number | null; max_pay_days: number | null; min_pay_days: number | null; closed_count: number }> = {};

  for (const [customerId, days] of Object.entries(grouped)) {
    const sorted = days.sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);

    // Median
    let median: number;
    if (n % 2 === 0) {
      median = (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    } else {
      median = sorted[Math.floor(n / 2)];
    }

    stats[customerId] = {
      avg_pay_days: +(sum / n).toFixed(1),
      median_pay_days: +median.toFixed(1),
      max_pay_days: sorted[n - 1],
      min_pay_days: sorted[0],
      closed_count: n,
    };
  }

  res.json({ stats });
});

// Delete customer
router.delete("/:id", (req: Request, res: Response) => {
  const { id } = req.params;

  const customer = db
    .prepare("SELECT id FROM customers WHERE id = ? AND user_id = ?")
    .get(id, req.user!.userId);

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  db.prepare("DELETE FROM customers WHERE id = ?").run(id);
  res.json({ success: true });
});

export default router;
