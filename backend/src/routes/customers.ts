import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// All routes require authentication
router.use(requireAuth);

// List customers
router.get("/", (req: Request, res: Response) => {
  const rows = db
    .prepare("SELECT id, name, created_at FROM customers WHERE user_id = ? ORDER BY name")
    .all(req.user!.userId);

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
