import db from "../../../db/index.js";

/**
 * WhizUnik Cloud API schema — exact-spec tables for the TallyPrime
 * desktop connector (outbound HTTPS only, base URL https://api.whizunik.com).
 *
 * Tables (exact names requested):
 *  - tenants(id, name, created_at)
 *  - connectors(connector_id, device_id, tenant_id, refresh_token_hash, ...)
 *  - companies(whizunik company id, tally_guid, tenant_id, ...)
 *  - sync_batches(batch_id UNIQUE, request_id UNIQUE, sync_id, entity_type,
 *                 received_count, duplicate, created_at)
 *  - pairing_codes(code, tenant_id, company link, expiry, single-use)
 *
 * Idempotent — safe to run on every startup. No dependency on the legacy
 * tally_* tables; the connect handler bridges legacy pairing codes so both
 * old and new connectors keep working.
 */

export const WHIZUNIK_MIGRATION_NAME = "v5_whizunik_cloud_api";

export function ensureWhizunikSchema(): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Tenant',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL UNIQUE,
      device_id TEXT,
      device_name TEXT,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      refresh_token_hash TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      app_version TEXT,
      protocol_version TEXT,
      tally_version TEXT,
      last_heartbeat TEXT,
      last_sync TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_connectors_tenant ON connectors(tenant_id)"); } catch { /* noop */ }
  try { db.run("CREATE INDEX IF NOT EXISTS idx_connectors_device ON connectors(device_id)"); } catch { /* noop */ }

  db.run(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      tally_guid TEXT,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Company',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tenant_id, tally_guid)
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_companies_tenant ON companies(tenant_id)"); } catch { /* noop */ }

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_batches (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL UNIQUE,
      request_id TEXT NOT NULL UNIQUE,
      sync_id TEXT,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
      connector_id TEXT REFERENCES connectors(connector_id) ON DELETE CASCADE,
      company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
      entity_type TEXT NOT NULL DEFAULT 'unknown',
      received_count INTEGER NOT NULL DEFAULT 0,
      duplicate INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_sync_batches_sync ON sync_batches(sync_id)"); } catch { /* noop */ }

  db.run(`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      company_name TEXT,
      tally_guid TEXT,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_pairing_codes_tenant ON pairing_codes(tenant_id)"); } catch { /* noop */ }

  // Received records: every record from every accepted batch is stored so the
  // platform (and operators) can inspect what the connector pushed.
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_records (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES sync_batches(batch_id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
      entity_type TEXT NOT NULL,
      source_object_id TEXT,
      source_voucher_number TEXT,
      source_voucher_date TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_sync_records_lookup ON sync_records(tenant_id, company_id, entity_type, created_at)"); } catch { /* noop */ }
  try { db.run("CREATE INDEX IF NOT EXISTS idx_sync_records_batch ON sync_records(batch_id)"); } catch { /* noop */ }

  // Cloud → connector commands. The connector is outbound-only, so pushes are
  // queued here and polled by the connector (GET /commands/pending), then
  // acknowledged (POST /commands/ack). Nothing ever dials in to the PC.
  db.run(`
    CREATE TABLE IF NOT EXISTS connector_commands (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      connector_id TEXT NOT NULL,
      command TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','DONE','CANCELLED')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      completed_at TEXT
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_connector_commands_pending ON connector_commands(connector_id, status)"); } catch { /* noop */ }

  markApplied();
}

function markApplied(): void {
  const rows = db.exec(
    `SELECT id FROM _migrations WHERE name = '${WHIZUNIK_MIGRATION_NAME.replace(/'/g, "''")}'`
  );
  if (rows.length > 0 && rows[0].values.length > 0) return;
  const id = `${Date.now()}-whizunik-cloud`;
  try {
    db.prepare("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(id, WHIZUNIK_MIGRATION_NAME);
  } catch { /* already applied concurrently */ }
}
