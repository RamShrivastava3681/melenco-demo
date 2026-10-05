import "dotenv/config";
import { createApp } from "./app.js";
import { initializeDatabase, startAutoSave, stopAutoSave, saveDb } from "./db/index.js";
import { startTallyRetentionJob } from "./integrations/tally/services/rawStore.service.js";

async function main() {
  // Initialize database tables
  await initializeDatabase();

  // Auto-save SQLite database to disk every 5 seconds
  startAutoSave();

  const app = createApp();
  const PORT = parseInt(process.env.PORT || "3001", 10);

  // Tally raw-record retention cleanup (safe no-op if disabled)
  const stopRetention = startTallyRetentionJob();

  // Start server
  const server = app.listen(PORT, () => {
    console.log(`🚀 Ledgerly API server running at http://localhost:${PORT}`);
  });

  // Graceful shutdown — save SQLite database before exit
  const shutdown = async (signal: string) => {
    console.log(`\n📦 ${signal} received. Saving database and shutting down...`);
    stopAutoSave();
    stopRetention();
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
