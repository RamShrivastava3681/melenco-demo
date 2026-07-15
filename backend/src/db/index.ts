import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic, QueryExecResult } from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let SQL: SqlJsStatic;
let db: SqlJsDatabase;
let dbPath: string;

// --- Wrapper to provide better-sqlite3-like API ---
class StatementWrapper {
  private sql: string;

  constructor(sql: string) {
    this.sql = sql;
  }

  all(...params: any[]): any[] {
    const stmt = db.prepare(this.sql);
    if (params.length > 0) stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  get(...params: any[]): any | undefined {
    const stmt = db.prepare(this.sql);
    if (params.length > 0) stmt.bind(params);
    const hasRow = stmt.step();
    const row = hasRow ? stmt.getAsObject() : undefined;
    stmt.free();
    return row;
  }

  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint } {
    const stmt = db.prepare(this.sql);
    if (params.length > 0) stmt.bind(params);
    stmt.step();
    stmt.free();
    // sql.js doesn't give us changes/lastID directly, so approximate
    return { changes: 1, lastInsertRowid: 0 };
  }
}

function prepare(sql: string): StatementWrapper {
  return new StatementWrapper(sql);
}

/**
 * Execute SQL and return results.
 * Uses sql.js Database.exec() under the hood so callers get proper
 * QueryExecResult[] (array of {columns, values}) back.
 */
function exec(sql: string): QueryExecResult[] {
  return db.exec(sql);
}

export { prepare, exec };

export function transaction(fn: () => void): () => void {
  return () => {
    db.run("BEGIN TRANSACTION");
    try {
      fn();
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
  };
}

function getDbPath(): string {
  const envPath = process.env.DATABASE_URL;
  if (envPath) {
    if (path.isAbsolute(envPath)) return envPath;
    return path.resolve(__dirname, "../..", envPath);
  }
  const dataDir = path.resolve(__dirname, "../../data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, "ledgerly.db");
}

// ---------------------------------------------------------------------------
// Migration helpers
// ---------------------------------------------------------------------------

/** Ensure the _migrations tracking table exists. */
function ensureMigrationsTable(): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/** Return true if a migration with the given name has already been applied. */
function isMigrationApplied(name: string): boolean {
  const rows = exec(
    `SELECT id FROM _migrations WHERE name = '${name.replace(/'/g, "''")}'`
  );
  return rows.length > 0 && rows[0].values.length > 0;
}

/** Record a migration as applied. */
function markMigrationApplied(name: string): void {
  // Generate a simple UUID-like id
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  db.run(
    "INSERT INTO _migrations (id, name) VALUES (?, ?)",
    [id, name]
  );
}

/**
 * Migrate a table's CHECK constraint by:
 *  1. CREATE `{table}_new` with the new schema
 *  2. INSERT data from old table into new table
 *  3. DROP old table (FK refs stay as-is — SQLite only updates FKs on RENAME, not DROP)
 *  4. ALTER TABLE `{table}_new` RENAME TO `{table}` (FK now points to the renamed new table)
 *
 * This avoids SQLite's "FK auto-update on RENAME" bug where renaming a table
 * causes FK references in OTHER tables to point to the OLD (renamed) table name.
 */
function migrateTableSafe(
  table: string,
  oldPattern: string,
  newCreateSql: string,
  label: string,
): void {
  const rows = exec(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}'`
  );
  if (rows.length === 0 || rows[0].values.length === 0) return;
  const createSql = rows[0].values[0][0] as string;
  if (!createSql.includes(oldPattern)) return;

  console.log(`  → Migrating ${label}...`);

  const newName = `${table}_new`;

  // 1. Create new table
  db.run(newCreateSql);

  // 2. Copy data
  db.run(`INSERT INTO ${newName} SELECT * FROM ${table}`);

  // 3. Drop old table — FK refs in other tables stay as-is (pointing to `{table}`)
  db.run(`DROP TABLE ${table}`);

  // 4. Rename new table to original name — FK refs now correctly point to it
  db.run(`ALTER TABLE ${newName} RENAME TO ${table}`);

  console.log(`  ✅ Done: ${label}`);
}

/** Migrate CHECK constraints on invoices, payments, and payment_allocations
 *  to allow negative values (for credit notes, refunds, etc.). */
function migrateConstraintsForNegatives(): void {
  const MIGRATION_NAME = "v2_allow_negative_amounts";

  if (isMigrationApplied(MIGRATION_NAME)) {
    console.log("  ↳ Already applied, skipping.");
    return;
  }

  // Use the "create _new → copy → drop old → rename _new" approach
  // to avoid SQLite's FK-auto-update-on-rename pitfall.
  const migrations: {
    table: string;
    oldPattern: string;
    newCreateSql: string;
    label: string;
  }[] = [
    {
      table: "invoices",
      oldPattern: "CHECK (amount > 0)",
      newCreateSql: `
        CREATE TABLE invoices_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          invoice_number TEXT NOT NULL,
          issue_date TEXT NOT NULL,
          due_date TEXT NOT NULL,
          amount REAL NOT NULL CHECK (amount != 0),
          balance REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
          closed_date TEXT,
          payment_days INTEGER,
          late_payment_days INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (user_id, customer_id, invoice_number)
        )
      `,
      label: "invoices: amount CHECK (amount != 0)",
    },
    {
      table: "payments",
      oldPattern: "CHECK (amount > 0)",
      newCreateSql: `
        CREATE TABLE payments_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          payment_date TEXT NOT NULL,
          amount REAL NOT NULL CHECK (amount != 0),
          applied_amount REAL NOT NULL DEFAULT 0,
          remaining REAL NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `,
      label: "payments: amount CHECK (amount != 0)",
    },
    {
      table: "payments",
      oldPattern: "CHECK (amount >= 0)",
      newCreateSql: `
        CREATE TABLE payments_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          payment_date TEXT NOT NULL,
          amount REAL NOT NULL CHECK (amount != 0),
          applied_amount REAL NOT NULL DEFAULT 0,
          remaining REAL NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `,
      label: "payments: amount CHECK (amount != 0) [from >=0]",
    },
    {
      table: "payment_allocations",
      oldPattern: "CHECK (amount_applied > 0)",
      newCreateSql: `
        CREATE TABLE payment_allocations_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
          invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
          amount_applied REAL NOT NULL CHECK (amount_applied != 0),
          applied_date TEXT NOT NULL,
          closed_invoice INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `,
      label: "payment_allocations: amount_applied CHECK (amount_applied != 0)",
    },
  ];

  // Wrap the entire migration in a transaction so partial failures roll back
  const tx = transaction(() => {
    for (const m of migrations) {
      migrateTableSafe(m.table, m.oldPattern, m.newCreateSql, m.label);
    }
    markMigrationApplied(MIGRATION_NAME);
  });

  try {
    tx();
  } catch (e) {
    console.error(`❌ Migration "${MIGRATION_NAME}" failed:`, e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Repair: fix broken FK refs in payment_allocations caused by earlier buggy
// migrations (where ALTER TABLE RENAME caused SQLite to auto-update FKs
// to point to the old renamed table name).
// ---------------------------------------------------------------------------
function repairPaymentAllocationsFK(): void {
  const rows = exec(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_allocations'`
  );
  if (rows.length === 0 || rows[0].values.length === 0) return;
  const createSql = rows[0].values[0][0] as string;

  // Check if FK is broken — points to payments_old or invoices_old
  if (
    !createSql.includes('REFERENCES "payments_old"') &&
    !createSql.includes("REFERENCES payments_old") &&
    !createSql.includes('REFERENCES "invoices_old"') &&
    !createSql.includes("REFERENCES invoices_old")
  ) {
    return; // FK is already correct
  }

  console.log("  → Repairing broken FK references in payment_allocations...");

  const repairedSql = `
    CREATE TABLE payment_allocations_repaired (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      amount_applied REAL NOT NULL CHECK (amount_applied != 0),
      applied_date TEXT NOT NULL,
      closed_invoice INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `;

  db.run(repairedSql);
  db.run("INSERT INTO payment_allocations_repaired SELECT * FROM payment_allocations");
  db.run("DROP TABLE payment_allocations");
  db.run("ALTER TABLE payment_allocations_repaired RENAME TO payment_allocations");

  console.log("  ✅ FK references repaired.");
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export async function initializeDatabase(): Promise<void> {
  SQL = await initSqlJs();
  dbPath = getDbPath();

  // Load existing database or create new one
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Temporarily disable FK checks during schema setup
  db.run("PRAGMA foreign_keys = OFF");

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, name)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      invoice_number TEXT NOT NULL,
      issue_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount != 0),
      balance REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      closed_date TEXT,
      payment_days INTEGER,
      late_payment_days INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, customer_id, invoice_number)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      payment_date TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount != 0),
      applied_amount REAL NOT NULL DEFAULT 0,
      remaining REAL NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payment_allocations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
      invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      amount_applied REAL NOT NULL CHECK (amount_applied != 0),
      applied_date TEXT NOT NULL,
      closed_invoice INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Xero connections table
  db.run(`
    CREATE TABLE IF NOT EXISTS xero_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      xero_user_id TEXT,
      tenant_id TEXT,
      tenant_name TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_expires_at TEXT,
      session_state TEXT,
      connected_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id)
    )
  `);

  // Create indexes
  try { db.run("CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id, status)"); } catch {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_alloc_payment ON payment_allocations(payment_id)"); } catch {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_alloc_invoice ON payment_allocations(invoice_id)"); } catch {}

  // Ensure migration tracking table
  ensureMigrationsTable();

  // Repair broken FK references (from earlier buggy migrations)
  // FK is OFF here so we can freely drop/recreate tables
  repairPaymentAllocationsFK();

  // Run constraint migrations
  // FK is still OFF so DROP TABLE won't be blocked by dependent FK refs
  console.log("📋 Running schema migrations...");
  migrateConstraintsForNegatives();
  console.log("✅ Schema migrations complete.");

  // Seed admin user if configured
  await seedAdminUser();

  // Re-enable FK checks for the running application
  db.run("PRAGMA foreign_keys = ON");

  // Save to disk
  saveDb();

  console.log(`📦 Database initialized at: ${dbPath}`);
}

export function saveDb(): void {
  if (db && dbPath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(dbPath, buffer);
  }
}

// Auto-save periodically (every 5 seconds)
let saveTimer: ReturnType<typeof setInterval> | null = null;
export function startAutoSave(intervalMs = 5000): void {
  if (saveTimer) clearInterval(saveTimer);
  saveTimer = setInterval(() => saveDb(), intervalMs);
}

export function stopAutoSave(): void {
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
}

async function seedAdminUser(): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.log("⚠️  ADMIN_EMAIL or ADMIN_PASSWORD not set — skipping admin seed.");
    return;
  }

  // Check if admin user already exists
  const stmt = db.prepare("SELECT id FROM users WHERE email = ?");
  stmt.bind([adminEmail]);
  const hasRow = stmt.step();
  const existing = hasRow ? stmt.getAsObject() : undefined;
  stmt.free();

  if (existing) {
    console.log(`👤 Admin user already exists: ${adminEmail}`);
    return;
  }

  const { v4: uuidv4 } = await import("uuid");
  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(adminPassword, 10);

  db.run(
    "INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)",
    [id, adminEmail, passwordHash, "Admin"]
  );

  console.log(`✅ Admin user created: ${adminEmail}`);
}

// Make prepare/exec available as default export for convenience
export default { prepare, exec, transaction, saveDb, initializeDatabase };
