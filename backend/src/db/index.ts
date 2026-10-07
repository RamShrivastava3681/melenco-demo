/**
 * Database entrypoint — DynamoDB single-table backend.
 *
 * - Production: uses the DynamoDB table named by DYNAMODB_TABLE_PREFIX
 *   (e.g. "mickey-mouse") via the stores in ./stores*.ts.
 * - Tests: USE_MEMORY_DB / NODE_ENV=test switches ./dynamo.ts to an
 *   in-memory Map, reset by createTestDatabase().
 */
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { dbScan, clearMemoryDb, isMemoryMode, tableName } from "./dynamo.js";
import { getUserByEmail, seedUser } from "./storesCore.js";

export async function initializeDatabase(): Promise<void> {
  if (isMemoryMode()) {
    clearMemoryDb();
  } else {
    // Verify table access before serving traffic.
    const found = await dbScan(undefined, 1);
    void found;
  }
  await seedAdminUser();
  console.log(`📦 Database ready (DynamoDB table: ${tableName()})`);
}

/** Isolated database for the test suite (in-memory; safe to call repeatedly). */
export async function createTestDatabase(): Promise<void> {
  process.env.USE_MEMORY_DB = "1";
  clearMemoryDb();
}

async function seedAdminUser(): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.log("⚠️  ADMIN_EMAIL or ADMIN_PASSWORD not set — skipping admin seed.");
    return;
  }

  const existing = await getUserByEmail(adminEmail);
  if (existing) {
    console.log(`👤 Admin user already exists: ${adminEmail}`);
    return;
  }

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(adminPassword, 10);
  await seedUser(id, adminEmail, passwordHash, "Admin");
  console.log(`✅ Admin user created: ${adminEmail}`);
}

// Re-export stores for convenient imports.
export * from "./dynamo.js";
export * from "./keys.js";
export * from "./storesCore.js";
export * from "./storesTally.js";
export * from "./storesWhizunik.js";
