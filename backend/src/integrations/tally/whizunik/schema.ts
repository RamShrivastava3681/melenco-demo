import db from "../../../db/index.js";

/**
 * WhizUnik Cloud API schema — exact-spec tables for the TallyPrime
 * desktop connector (outbound HTTPS only, base URL https://excel.frillchills.com/api).
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

  // Phase 3 (WhizUnik → Tally master sync): per-master sync state, one row
  // per (tenant, kind, whizunik record). Absence of a row means NOT_SYNCED.
  // Status lifecycle: QUEUED → SENDING → SYNCED, with FAILED / NEEDS_REVIEW
  // as terminal-until-retried states. Direction is always 'outbound' here.
  db.run(`
    CREATE TABLE IF NOT EXISTS master_sync_links (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('customer','supplier','sku')),
      whizunik_id TEXT NOT NULL,
      tally_name TEXT,
      tally_master_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENDING','SYNCED','FAILED','NEEDS_REVIEW')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      idempotency_key TEXT,
      direction TEXT NOT NULL DEFAULT 'outbound',
      request_id TEXT,
      approved_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, kind, whizunik_id)
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_master_links_status ON master_sync_links(tenant_id, status)"); } catch { /* noop */ }
  try { db.run("CREATE INDEX IF NOT EXISTS idx_master_links_idem ON master_sync_links(idempotency_key)"); } catch { /* noop */ }

  // Phase 3 evidence log: every master sync attempt with request/response.
  // Never stores secrets — request/response hold master fields + Tally XML only.
  db.run(`
    CREATE TABLE IF NOT EXISTS master_sync_attempts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      connector_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      whizunik_id TEXT NOT NULL,
      company_id TEXT,
      request_id TEXT,
      idempotency_key TEXT,
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      responded_at TEXT,
      http_status INTEGER,
      tally_status TEXT,
      success INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      request_payload TEXT,
      response_payload TEXT
    )
  `);
  try { db.run("CREATE INDEX IF NOT EXISTS idx_master_attempts_lookup ON master_sync_attempts(tenant_id, kind, whizunik_id, requested_at)"); } catch { /* noop */ }

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
