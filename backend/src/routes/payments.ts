import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  listPayments,
  listPaymentsWithRemaining,
  zeroRemainingPayments,
  createPayment,
  getPayment,
  updatePayment,
  listInvoices,
  updateInvoice,
  createAllocation,
} from "../db/storesCore.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

// List payments
router.get("/", async (req: Request, res: Response) => {
  const rows = await listPayments(req.user!.userId);
  res.json({ payments: rows });
});

// Get customer balance (remaining from previous payments)
router.get("/balance/:customerId", async (req: Request, res: Response) => {
  const { customerId } = req.params as { customerId: string };

  const rows = await listPaymentsWithRemaining(req.user!.userId, customerId);

  const total = rows.reduce((sum, p) => sum + Number(p.remaining), 0);
  res.json({ remaining: total });
});

// Apply payment — the main reconciliation action
router.post("/apply", async (req: Request, res: Response) => {
  const {
    customer_id,
    payment_date,
    amount,
    note,
    selected_invoice_ids,
    use_balance = false,
    auto_fifo = false,
    close_future_invoices = false,
  } = req.body;

  if (!customer_id || !payment_date || amount === undefined || amount === null) {
    res.status(400).json({ error: "Missing required fields: customer_id, payment_date, amount" });
    return;
  }

  if (!auto_fifo && !Array.isArray(selected_invoice_ids)) {
    res.status(400).json({ error: "Missing required field: selected_invoice_ids" });
    return;
  }

  const userId = req.user!.userId;
  const paymentAmount = Number(amount);
  if (!isFinite(paymentAmount) || paymentAmount <= 0) {
    res.status(400).json({ error: "Invalid payment amount" });
    return;
  }

  try {
    // 1. Calculate available amount
    let availableAmount = paymentAmount;

    if (use_balance) {
      const balanceRows = await listPaymentsWithRemaining(userId, customer_id);
      const previousRemaining = balanceRows.reduce((sum, p) => sum + Number(p.remaining), 0);
      availableAmount += previousRemaining;

      // Consume all previous remaining balances
      await zeroRemainingPayments(userId, customer_id);
    }

    // 2. Create payment record
    const paymentId = uuidv4();
    let remainingAmount = availableAmount;
    let totalApplied = 0;
    const allocations: any[] = [];

    // 3. Allocate to invoices
    let invoiceRows: any[] = [];

    if (auto_fifo) {
      // FIFO mode: fetch open invoices ordered by due_date
      const all = await listInvoices(userId, { customer_id, status: "open" });
      if (close_future_invoices) {
        // Pass 1: only invoices due on or before payment date (future invoices handled in pass 2)
        invoiceRows = all.filter((i) => String(i.due_date || "") <= String(payment_date));
      } else {
        // Current behavior: all open invoices regardless of due date
        invoiceRows = all;
      }
    } else if (selected_invoice_ids.length > 0) {
      // Manual mode: fetch selected invoices
      const wanted = new Set(selected_invoice_ids);
      const all = await listInvoices(userId, { customer_id, status: "open" });
      invoiceRows = all
        .filter((i) => wanted.has(i.id))
        .sort((a, b) => String(a.due_date || "").localeCompare(String(b.due_date || "")));
    }

    if (invoiceRows.length === 0 && !auto_fifo) {
      res.status(500).json({ error: "No valid open invoices found" });
      return;
    }

    for (const inv of invoiceRows) {
      if (remainingAmount <= 0) break;

      const balance = Number(inv.balance);

      if (auto_fifo) {
        // FIFO mode: only close if full balance can be paid (no partials)
        if (remainingAmount < balance) {
          // Can't fully pay this invoice — skip it and try the next one
          continue;
        }
      }

      const apply = auto_fifo ? balance : Math.min(remainingAmount, balance);
      const newBalance = +(balance - apply).toFixed(2);
      const closes = newBalance <= 0;

      // Update invoice
      const updateAttrs: Record<string, any> = { balance: newBalance };

      if (closes) {
        const paymentDays = daysBetween(inv.issue_date as string, payment_date);
        const lateDays = Math.max(0, daysBetween(inv.due_date as string, payment_date));
        updateAttrs.status = "closed";
        updateAttrs.closed_date = payment_date;
        updateAttrs.payment_days = paymentDays;
        updateAttrs.late_payment_days = lateDays;
      }

      await updateInvoice(userId, inv.id as string, updateAttrs);

      // Create allocation
      const allocId = uuidv4();
      await createAllocation(userId, {
        id: allocId,
        payment_id: paymentId,
        invoice_id: inv.id,
        amount_applied: +apply.toFixed(2),
        applied_date: payment_date,
        closed_invoice: closes ? 1 : 0,
      });

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

    // 3b. If close_future_invoices is enabled, close future-dated invoices with remaining balance
    if (auto_fifo && close_future_invoices && remainingAmount > 0) {
      const all = await listInvoices(userId, { customer_id, status: "open" });
      // Re-fetch to exclude invoices closed in pass 1
      const closedIds = new Set(allocations.map((a) => a.invoice_id));
      const futureInvoices = all.filter(
        (i) => !closedIds.has(i.id as string) && String(i.due_date || "") > String(payment_date)
      );

      for (const inv of futureInvoices) {
        if (remainingAmount <= 0) break;
        const balance = Number(inv.balance);
        if (remainingAmount < balance) continue;

        // Close using invoice's due_date as the closed_date (payment made on due date)
        const closedDate = inv.due_date as string;
        const paymentDays = daysBetween(inv.issue_date as string, closedDate);
        const lateDays = 0;

        await updateInvoice(userId, inv.id as string, {
          balance: 0,
          status: "closed",
          closed_date: closedDate,
          payment_days: paymentDays,
          late_payment_days: lateDays,
        });

        const allocId = uuidv4();
        await createAllocation(userId, {
          id: allocId,
          payment_id: paymentId,
          invoice_id: inv.id,
          amount_applied: +balance.toFixed(2),
          applied_date: closedDate,
          closed_invoice: 1,
        });

        allocations.push({
          id: allocId,
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          amount_applied: +balance.toFixed(2),
          closed_invoice: true,
          future_closed: true,
        });

        totalApplied += balance;
        remainingAmount = +(remainingAmount - balance).toFixed(2);
      }
    }

    // 4. Insert payment record
    await createPayment(userId, {
      id: paymentId,
      customer_id,
      payment_date,
      amount: paymentAmount,
      applied_amount: +totalApplied.toFixed(2),
      remaining: +remainingAmount.toFixed(2),
      note: note || null,
    });

    res.status(201).json({
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
    });
  } catch (error: any) {
    console.error("Apply payment error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Subtract from payment remaining balance
router.patch("/:id/subtract-remaining", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { amount } = req.body;

  if (amount === undefined || amount === null || !isFinite(amount) || Number(amount) <= 0) {
    res.status(400).json({ error: "Provide a valid positive amount to subtract" });
    return;
  }

  const userId = req.user!.userId;

  const payment = await getPayment(userId, id) as any;

  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  const currentRemaining = Number(payment.remaining);
  const subtractAmount = Number(amount);

  if (subtractAmount > currentRemaining) {
    res.status(400).json({ error: `Cannot subtract more than the remaining balance (${currentRemaining.toFixed(2)})` });
    return;
  }

  const newRemaining = +(currentRemaining - subtractAmount).toFixed(2);

  await updatePayment(userId, id, { remaining: newRemaining });

  res.json({ success: true, remaining: newRemaining });
});

function daysBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(ms / 86400000);
}

export default router;
