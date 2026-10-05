import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import customerRoutes from "./routes/customers.js";
import invoiceRoutes from "./routes/invoices.js";
import paymentRoutes from "./routes/payments.js";
import allocationRoutes from "./routes/allocations.js";
import xeroRoutes from "./routes/xero.js";
import tallyRoutes from "./integrations/tally/index.js";

/**
 * Express app factory. Kept separate from index.ts so the test suite can
 * boot an isolated app instance against an in-memory database.
 */
export function createApp(): express.Express {
  const app = express();
  const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

  // Middleware
  app.use(cors({
    origin: FRONTEND_URL,
    credentials: true,
  }));
  app.use(express.json({ limit: "10mb" }));

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Routes
  app.use("/api/auth", authRoutes);
  app.use("/api/customers", customerRoutes);
  app.use("/api/invoices", invoiceRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/allocations", allocationRoutes);
  app.use("/api/xero", xeroRoutes);
  app.use("/api/integrations/tally", tallyRoutes);

  return app;
}

export default createApp;
