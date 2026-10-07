import "dotenv/config";
import { createApp } from "./app.js";
import { initializeDatabase } from "./db/index.js";
import { startTallyRetentionJob } from "./integrations/tally/services/rawStore.service.js";

async function main() {
  // Verify DynamoDB table access + seed admin user
  await initializeDatabase();

  const app = createApp();
  const PORT = parseInt(process.env.PORT || "3001", 10);

  // Tally raw-record retention cleanup (safe no-op if disabled)
  const stopRetention = startTallyRetentionJob();

  // Start server
  const server = app.listen(PORT, () => {
    console.log(`🚀 Ledgerly API server running at http://localhost:${PORT}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n📦 ${signal} received. Shutting down...`);
    stopRetention();
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
