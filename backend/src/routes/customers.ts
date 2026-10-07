import { Router, Request, Response } from "express";
import {
  listCustomers,
  createCustomer,
  getCustomer,
  deleteCustomer,
  listInvoices,
} from "../db/storesCore.js";
import { dbQueryPk } from "../db/dynamo.js";
import { userPk } from "../db/keys.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// All routes require authentication
router.use(requireAuth);

// List customers with outstanding and remaining balances
router.get("/", async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const [customers, invoices, payments] = await Promise.all([
    listCustomers(userId),
    listInvoices(userId, { status: "open" }),
    dbQueryPk(userPk(userId), "PAYMENT#"),
  ]);

  const openByCustomer = new Map<string, number>();
  for (const inv of invoices) {
    const cid = inv.customer_id as string;
    openByCustomer.set(cid, (openByCustomer.get(cid) || 0) + Number(inv.balance || 0));
  }
  const remByCustomer = new Map<string, number>();
  for (const p of payments) {
    if (Number(p.remaining) > 0) {
      const cid = p.customer_id as string;
      remByCustomer.set(cid, (remByCustomer.get(cid) || 0) + Number(p.remaining || 0));
    }
  }

  const rows = customers.map((c) => ({
    id: c.id,
    name: c.name,
    created_at: c.created_at,
    outstanding_balance: openByCustomer.get(c.id as string) || 0,
    remaining_balance: remByCustomer.get(c.id as string) || 0,
  }));

  res.json({ customers: rows });
});

// Create customer
router.post("/", async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }

  try {
    const created = await createCustomer(req.user!.userId, name.trim());
    res.status(201).json({
      customer: { id: created.id, name: created.name, created_at: created.created_at },
    });
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
router.get("/stats", async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  // Get all closed invoices with payment_days for this user
  const closed = await listInvoices(userId, { status: "closed" });
  const rows = closed
    .filter((r) => r.payment_days !== null && r.payment_days !== undefined)
    .sort((a, b) => {
      const c = String(a.customer_id || "").localeCompare(String(b.customer_id || ""));
      if (c !== 0) return c;
      return Number(a.payment_days) - Number(b.payment_days);
    });

  // Group by customer and compute stats
  const grouped: Record<string, number[]> = {};
  for (const row of rows) {
    const cid = row.customer_id as string;
    if (!grouped[cid]) grouped[cid] = [];
    grouped[cid].push(Number(row.payment_days));
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
router.delete("/:id", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const customer = await getCustomer(req.user!.userId, id);

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  await deleteCustomer(req.user!.userId, id);
  res.json({ success: true });
});

export default router;
