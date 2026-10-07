import { Router, Request, Response } from "express";
import { listAllocations } from "../db/storesCore.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

// List all allocations
router.get("/", async (req: Request, res: Response) => {
  const rows = await listAllocations(req.user!.userId);
  res.json({ allocations: rows });
});

export default router;
