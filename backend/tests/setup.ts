/**
 * Global test setup: isolated in-memory database per test file.
 * The prod entrypoint (index.ts) is never imported by tests.
 *
 * NOTE: DB initialization is exported, not run at import time — vitest
 * setup files run in a different module context than the test file's
 * imports, so `db` state must be initialized from the test file itself.
 */
import { createTestDatabase } from "../src/db/index.js";

export async function initTestDb(): Promise<void> {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  await createTestDatabase();
}
