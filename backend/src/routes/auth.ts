import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import db from "../db/index.js";
import { generateToken, requireAuth } from "../middleware/auth.js";

const router = Router();

router.post("/signup", (req: Request, res: Response) => {
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

    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }

    const id = uuidv4();
    const passwordHash = bcrypt.hashSync(password, 10);
    const displayName = name || email.split("@")[0];

    db.prepare(
      "INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)"
    ).run(id, email, passwordHash, displayName);

    const token = generateToken({ userId: id, email });

    res.status(201).json({
      token,
      user: { id, email, name: displayName },
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/signin", (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const user = db
      .prepare("SELECT id, email, password_hash, name FROM users WHERE email = ?")
      .get(email) as { id: string; email: string; password_hash: string; name: string } | undefined;

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

router.get("/me", requireAuth, (req: Request, res: Response) => {
  const user = db
    .prepare("SELECT id, email, name, created_at FROM users WHERE id = ?")
    .get(req.user!.userId) as { id: string; email: string; name: string; created_at: string } | undefined;

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({ user });
});

export default router;
