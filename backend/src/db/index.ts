import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from "sql.js";
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

function exec(sql: string): void {
  db.run(sql);
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

  db.run("PRAGMA foreign_keys = ON");

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
      amount REAL NOT NULL CHECK (amount > 0),
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
      amount REAL NOT NULL CHECK (amount > 0),
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
      amount_applied REAL NOT NULL CHECK (amount_applied > 0),
      applied_date TEXT NOT NULL,
      closed_invoice INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Create indexes
  try { db.run("CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id, status)"); } catch {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_alloc_payment ON payment_allocations(payment_id)"); } catch {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_alloc_invoice ON payment_allocations(invoice_id)"); } catch {}

  // Seed admin user if configured
  await seedAdminUser();

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
