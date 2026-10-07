import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { createUser, getUserById, getUserByEmail } from "../db/storesCore.js";
import { generateToken, requireAuth } from "../middleware/auth.js";

const router = Router();

router.post("/signup", async (req: Request, res: Response) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters" });
      return;
    }

    const existing = await getUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const displayName = name || email.split("@")[0];

    const user = await createUser(email, passwordHash, displayName);

    const token = generateToken({ userId: user.id, email });

    res.status(201).json({
      token,
      user: { id: user.id, email, name: displayName },
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/signin", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const user = await getUserByEmail(email);

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const token = generateToken({ userId: user.id, email: user.email });

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (error) {
    console.error("Signin error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/me", requireAuth, async (req: Request, res: Response) => {
  const user = await getUserById(req.user!.userId);

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ user: { id: user.id, email: user.email, name: user.name, created_at: user.created_at } });
});

export default router;
