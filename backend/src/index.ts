import "dotenv/config";
import express from "express";
import cors from "cors";
import { initializeDatabase, startAutoSave, stopAutoSave, saveDb } from "./db/index.js";
import authRoutes from "./routes/auth.js";
import customerRoutes from "./routes/customers.js";
import invoiceRoutes from "./routes/invoices.js";
import paymentRoutes from "./routes/payments.js";
import allocationRoutes from "./routes/allocations.js";
import xeroRoutes from "./routes/xero.js";

async function main() {
  // Initialize database tables
  await initializeDatabase();

  // Auto-save SQLite database to disk every 5 seconds
  startAutoSave();

  const app = express();
  const PORT = parseInt(process.env.PORT || "3001", 10);
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

  // Start server
  const server = app.listen(PORT, () => {
    console.log(`🚀 Ledgerly API server running at http://localhost:${PORT}`);
    console.log(`   Frontend origin: ${FRONTEND_URL}`);
  });

  // Graceful shutdown — save SQLite database before exit
  const shutdown = async (signal: string) => {
    console.log(`\n📦 ${signal} received. Saving database and shutting down...`);
    stopAutoSave();
    saveDb();
    server.close(() => {
      console.log("👋 Server closed.");
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
