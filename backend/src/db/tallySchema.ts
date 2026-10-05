import db from "./index.js";

/**
 * TallyPrime cloud integration schema.
 *
 * Tenant model: the existing WhizUnik `users.id` is the tenant key
 * (`user_id` column, same convention as customers/invoices/payments).
 *
 * All statements are idempotent so this can run on every startup.
 * A `_migrations` marker (v4_tally_integration) is recorded so future
 * structural changes can be gated the same way existing migrations are.
 */

export const TALLY_MIGRATION_NAME = "v4_tally_integration";

export function ensureTallySchema(): void {
  // -- Company registry (validates the companyId supplied by connectors) ----
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_companies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tally_company_guid TEXT NOT NULL,
      tally_company_name TEXT NOT NULL,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, tally_company_guid)
    )
  `);

  // -- Connectors ------------------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_connectors (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connector_id TEXT NOT NULL UNIQUE,
      connector_name TEXT NOT NULL DEFAULT 'Tally Connector',
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ONLINE','OFFLINE','REVOKED')),
      device_name TEXT,
      device_id TEXT,
      app_version TEXT,
      token_hash TEXT NOT NULL,
      hmac_secret_hash TEXT,
      pairing_code_id TEXT,
      last_heartbeat TEXT,
      last_sync TEXT,
      last_successful_sync TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_tally_connectors_user ON tally_connectors(user_id, status)"); } catch {}

  // -- Pairing codes (stored hashed, single-use, short TTL) -------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_pairing_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_tally_pairing_user ON tally_pairing_codes(user_id, expires_at)"); } catch {}

  // -- Sync sessions ----------------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_sync_sessions (
      id TEXT PRIMARY KEY,
      sync_id TEXT NOT NULL UNIQUE,
      connector_id TEXT NOT NULL REFERENCES tally_connectors(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES tally_companies(id) ON DELETE CASCADE,
      tally_company_id TEXT,
      sync_type TEXT NOT NULL CHECK (sync_type IN ('INITIAL_SYNC','INCREMENTAL_SYNC','MANUAL_SYNC','RETRY_SYNC','FULL_RESYNC')),
      entity_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETED','PARTIAL','FAILED','CANCELLED')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      total_records INTEGER NOT NULL DEFAULT 0,
      processed_records INTEGER NOT NULL DEFAULT 0,
      successful_records INTEGER NOT NULL DEFAULT 0,
      duplicate_records INTEGER NOT NULL DEFAULT 0,
      failed_records INTEGER NOT NULL DEFAULT 0,
      total_batches INTEGER NOT NULL DEFAULT 0,
      processed_batches INTEGER NOT NULL DEFAULT 0,
      error_message TEXT
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_tally_sessions_user ON tally_sync_sessions(user_id, started_at)"); } catch {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_tally_sessions_connector ON tally_sync_sessions(connector_id, started_at)"); } catch {}

  // -- Batches (idempotent ACK replay) ----------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_batches (
      id TEXT PRIMARY KEY,
      sync_id TEXT NOT NULL REFERENCES tally_sync_sessions(id) ON DELETE CASCADE,
      batch_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('ACCEPTED','REJECTED','PROCESSED','FAILED')),
      accepted INTEGER NOT NULL DEFAULT 0,
      duplicates INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      ack_json TEXT,
      request_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (sync_id, batch_number)
    )
  `);

  // -- Source records (idempotency spine) --------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_source_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES tally_companies(id) ON DELETE CASCADE,
      source TEXT NOT NULL DEFAULT 'tally',
      entity_type TEXT NOT NULL,
      source_object_id TEXT NOT NULL,
      source_company_id TEXT,
      source_voucher_number TEXT,
      source_voucher_type TEXT,
      source_voucher_date TEXT,
      content_hash TEXT,
      whizunik_table TEXT,
      whizunik_record_id TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      sync_id TEXT,
      UNIQUE (user_id, company_id, source, entity_type, source_object_id)
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_tally_source_lookup ON tally_source_records(user_id, company_id, entity_type, source_voucher_number)"); } catch {}

  // -- Raw/staging payloads ------------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_raw_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connector_id TEXT NOT NULL REFERENCES tally_connectors(id) ON DELETE CASCADE,
      company_id TEXT REFERENCES tally_companies(id) ON DELETE SET NULL,
      sync_id TEXT,
      entity_type TEXT NOT NULL,
      source_object_id TEXT,
      payload TEXT NOT NULL,
      processing_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (processing_status IN ('PENDING','PROCESSED','FAILED','DISCARDED')),
      error_message TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_tally_raw_received ON tally_raw_records(received_at)"); } catch {}
  try { db.run("CREATE INDEX IF NOT EXISTS idx_tally_raw_sync ON tally_raw_records(sync_id)"); } catch {}

  // -- Checkpoints (incremental sync, per company + entity type) ---------------
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_sync_checkpoints (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES tally_companies(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      last_sync_at TEXT,
      last_object_id TEXT,
      last_voucher_date TEXT,
      last_voucher_number TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, company_id, entity_type)
    )
  `);

  // -- Audit log -----------------------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      connector_id TEXT,
      sync_id TEXT,
      event TEXT NOT NULL,
      request_id TEXT,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_tally_audit_user ON tally_audit_logs(user_id, created_at)"); } catch {}

  // -- Normalized: suppliers -------------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, name)
    )
  `);

  // -- Normalized: products / stock items --------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      group_name TEXT,
      category TEXT,
      base_unit TEXT,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, name)
    )
  `);

  // -- Normalized: chart-of-accounts style ledgers ------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_ledgers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES tally_companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      parent_group TEXT,
      ledger_type TEXT,
      opening_balance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, company_id, name)
    )
  `);

  // -- Normalized: purchase invoices ---------------------------------------------------
  db.run(`
    CREATE TABLE IF NOT EXISTS purchase_invoices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
      invoice_number TEXT NOT NULL,
      issue_date TEXT NOT NULL,
      due_date TEXT,
      amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, supplier_id, invoice_number)
    )
  `);

  // -- Normalized: generic voucher store (all voucher types not mapped above) -----------
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_vouchers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES tally_companies(id) ON DELETE CASCADE,
      voucher_type TEXT NOT NULL,
      voucher_number TEXT,
      voucher_date TEXT,
      party_ledger TEXT,
      amount REAL NOT NULL DEFAULT 0,
      narrative TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_tally_vouchers_type ON tally_vouchers(user_id, company_id, voucher_type)"); } catch {}

  // -- Report payloads (scaffold; connector executes configured queries locally) --------
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES tally_companies(id) ON DELETE CASCADE,
      report_type TEXT NOT NULL,
      report_date TEXT,
      payload TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, company_id, report_type, report_date)
    )
  `);

  // -- Sync commands (cloud → connector control plane, delivered via /config or heartbeat) --
  db.run(`
    CREATE TABLE IF NOT EXISTS tally_sync_commands (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connector_id TEXT NOT NULL REFERENCES tally_connectors(id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','DONE','CANCELLED')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      completed_at TEXT
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_tally_commands_pending ON tally_sync_commands(connector_id, status)"); } catch {}

  markApplied();
}

function markApplied(): void {
  const rows = db.exec(
    `SELECT id FROM _migrations WHERE name = '${TALLY_MIGRATION_NAME.replace(/'/g, "''")}'`
  );
  if (rows.length > 0 && rows[0].values.length > 0) return;
  const id = `${Date.now()}-tally`;
  db.prepare("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(
    id,
    TALLY_MIGRATION_NAME
  );
}
