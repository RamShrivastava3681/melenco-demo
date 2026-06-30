import { Router, Request, Response } from "express";
import db from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

// List all allocations
router.get("/", (req: Request, res: Response) => {
  const rows = db
    .prepare("SELECT * FROM payment_allocations WHERE user_id = ?")
    .all(req.user!.userId);

  res.json({ allocations: rows });
});

export default router;
