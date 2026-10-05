# TallyPrime Cloud Integration — WhizUnik Command

Production-ready cloud-side integration between customer TallyPrime installations and WhizUnik via a local Windows connector. **No inbound internet access to the customer's machine is ever required** — the connector makes outbound HTTPS calls only.

```
Customer Windows PC ──> Local Tally Connector ──HTTPS──> WhizUnik Tally API
                                                            │
                                              Validation → Deduplication → Normalization
                                                            │
                                                    WhizUnik database
```

- Module location: `backend/src/integrations/tally/`
- Tests: `backend/tests/` (34 tests, `npm test` in `backend/`)
- Frontend: `frontend/src/components/app/TallyConnectCard.tsx`

---

## 1. Architecture

| Layer | Responsibility |
|---|---|
| `routes/connector.routes.ts` | Connector-facing HTTP endpoints (connect, heartbeat, config, sync/*) |
| `routes/status.routes.ts` | Frontend (JWT) endpoints — pairing code, status, history, disconnect |
| `middleware/connectorAuth.ts` | Token + HMAC + replay-protection authentication |
| `middleware/rateLimiter.ts` | Per-connector / per-IP sliding-window limits, HTTP 429 + Retry-After |
| `services/` | Pairing, connectors, companies, sessions, batches, checkpoints, raw store, audit, config, status |
| `normalizers/` | Per-entity mapping into WhizUnik tables (registry pattern) |
| `validators/` | Zod schemas for every HTTP envelope and record |
| `utils/` | Crypto (tokens/HMAC/pairing codes), env config, request-scoped logger |

**Tenant model:** WhizUnik `users.id` is the tenant key (same convention as existing invoices/customers). A connector is bound to exactly one tenant; the tenant is **always derived from the connector record**, never from client-supplied payload fields.

**Deployment constraint:** the API is a single-process Express app with SQLite (sql.js). Do not run multiple instances; the schema and code stay portable to Postgres if needed later.

---

## 2. Pairing flow (Settings → Integrations → Tally → Connect Tally)

1. User clicks **Connect Tally** in the WhizUnik frontend → `POST /api/integrations/tally/pairing-code` (JWT).
2. Backend returns a one-time code `WZK-XXXX-XXXX` valid for `TALLY_PAIRING_CODE_TTL_MINUTES` (default 10). Only a SHA-256 hash is stored; the plaintext is shown once.
3. The local connector submits the code to `POST /api/integrations/tally/connect` along with device info and the list of Tally companies.
4. Backend: validates + consumes the code (single-use), creates the connector record, generates credentials, maps companies, and returns the configuration.
5. The plaintext `accessToken` and `hmacSecret` are returned **exactly once** — only hashes are stored server-side.

Response example:

```json
{
  "success": true,
  "connectorId": "tc_wdGIqDzzLuihbwFz",
  "accessToken": "…base64url…",
  "hmacSecret": "…base64url…",
  "apiBaseUrl": "",
  "heartbeatIntervalSeconds": 120,
  "companies": [{ "id": "comp_…", "tallyCompanyGuid": "guid-1111", "name": "Test Company Ltd" }],
  "config": { "batchLimits": { "maxRecords": 500, "maxBytes": 2097152 }, "entities": [ … ], "checkpoints": [], "reports": { … } }
}
```

---

## 3. Connector authentication

Every connector request (except `/connect`) must send:

| Header | Meaning |
|---|---|
| `Authorization: Bearer <accessToken>` | Secret token (stored hashed, constant-time compare) |
| `X-Connector-Id: <connectorId>` | Public connector id |
| `X-Request-Id: <uuid>` | Unique per request — replays rejected |
| `X-Timestamp` | Epoch milliseconds, ±`TALLY_REQUEST_TIMESTAMP_WINDOW_SEC` (default 300) |
| `X-Signature` | Optional HMAC-SHA256 hex (mandatory when `TALLY_HMAC_REQUIRED=true`) |

HMAC canonical string: `connectorId|requestId|timestamp|METHOD|path|sha256(body)`.

Server-side protections: unknown connector → 401; revoked connector → 401; bad token → 401; stale timestamp → 401; duplicate `X-Request-Id` → 401. Cross-tenant access is impossible because the tenant always comes from the connector row.

---

## 4. Sync lifecycle

```
POST /sync/start  → { syncId, batchSize, nextBatch: 1 }
POST /sync/batch  → { success, syncId, batchNumber, accepted, duplicates, failed, nextBatch }   (per batch)
POST /sync/complete → final session status + checkpoint persistence
POST /sync/error  → marks session FAILED (connector reports fatal errors)
```

Statuses: `PENDING → RUNNING → COMPLETED | PARTIAL | FAILED | CANCELLED`.

Rules:
- One active session per connector + company + entity type (duplicate start → `INVALID_BATCH` with the active `syncId` in `details`).
- Batches are only accepted into active sessions; re-sending an already-processed batch replays the stored ACK without reprocessing (safe retries even after completion).
- Session entity type must match the batch declaration; company must belong to the connector's tenant.

### Batch request

```json
{
  "syncId": "sync_ab12cd34ef05gh67",
  "companyId": "comp_…",
  "entityType": "SALES_VOUCHER",
  "batchNumber": 1,
  "totalBatches": 10,
  "records": [
    {
      "tallyGuid": "REMOTEGUID-…",
      "voucherType": "Sales",
      "voucherNumber": "INV-00001",
      "voucherDate": "2026-07-01",
      "partyName": "Acme Traders",
      "amount": 11800.0,
      "data": { "dueDate": "2026-08-01", "narration": "…" }
    }
  ]
}
```

Constraints: ≤ `TALLY_BATCH_MAX_RECORDS` records (default 500) and ≤ `TALLY_BATCH_MAX_BYTES` bytes (default 2 MB) per batch; record-level failures don't fail the batch — they're counted in `failed` and logged without payload contents.

### Idempotency

Source identity = `tenantId + companyId + source("tally") + entityType + sourceObjectId`, unique in `tally_source_records`.

- `sourceObjectId` = Tally REMOTEGUID/GUID when available.
- Vouchers without a GUID: deterministic fallback `FBA-<sha256(voucherType|voucherNumber|voucherDate|partyName)>`.
- Masters without a GUID: `NAME-<entityType>-<NAME>`.
- Identical retransmission (same content hash) → counted as `duplicates`, no writes.
- Changed content for a known id → normalized record updated (counted as `accepted`), original ids never overwritten.
- Records without any usable identity → counted as `failed` with `TALLY_DATA_INVALID`.

### Incremental sync

Checkpoints per `tenant + company + entityType` are stored cloud-side and served through `GET /config`. Fields: `lastSyncAt`, `lastObjectId`, `lastVoucherDate`, `lastVoucherNumber` (not every Tally object shares the same incremental identifier). The connector never invents incremental logic — it follows the config.

Sync types: `INITIAL_SYNC`, `INCREMENTAL_SYNC`, `MANUAL_SYNC`, `RETRY_SYNC`, `FULL_RESYNC` (a resync reads the config; clearing checkpoints is an admin operation on `tally_sync_checkpoints`).

---

## 5. Entity types

**Records (ingestion):** `COMPANY, GROUP, LEDGER, STOCK_GROUP, STOCK_CATEGORY, STOCK_ITEM, UNIT, GODOWN, VOUCHER_TYPE, SALES_VOUCHER, PURCHASE_VOUCHER, RECEIPT_VOUCHER, PAYMENT_VOUCHER, JOURNAL_VOUCHER, CONTRA_VOUCHER, DEBIT_NOTE, CREDIT_NOTE, SALES_ORDER, PURCHASE_ORDER, DELIVERY_NOTE, RECEIPT_NOTE, STOCK_JOURNAL`

**Reports (scaffolded):** `BALANCE_SHEET, PROFIT_LOSS, TRIAL_BALANCE, DAY_BOOK, OUTSTANDING_RECEIVABLES, OUTSTANDING_PAYABLES, STOCK_SUMMARY, GST_REPORTS` — stored in `tally_reports`. Tally query XML is **never guessed in code**: report definitions are declarative placeholders served via config; operators supply per-TallyPrime-version query templates later.

### Normalization mapping

| Tally | WhizUnik table |
|---|---|
| LEDGER with `partyType: debtor/customer` | `customers` (+ ledger row kept) |
| LEDGER with `partyType: creditor/supplier` | `suppliers` (+ ledger row kept) |
| LEDGER (other) | `tally_ledgers` |
| SALES_VOUCHER | `invoices` (existing table; party → customer) |
| RECEIPT_VOUCHER | `payments` + `payment_allocations` (FIFO against open invoices, mirrors existing allocation logic) |
| PURCHASE_VOUCHER | `purchase_invoices` |
| STOCK_ITEM | `products` |
| COMPANY | updates `tally_companies` |
| GROUP / STOCK_GROUP / STOCK_CATEGORY / UNIT / GODOWN / VOUCHER_TYPE | `tally_ledgers` (typed rows) |
| All other vouchers/notes/orders | `tally_vouchers` (generic store with full raw JSON) |

Original Tally identifiers are always preserved in `tally_source_records` (`source_object_id`, `source_voucher_number`, `source_voucher_type`, `source_voucher_date`) — never silently overwritten.

---

## 6. Raw/staging layer

Every uploaded record is stored in `tally_raw_records` before normalization (`payload` JSON, `processing_status`, `received_at`). Retention: purged after `TALLY_RAW_RETENTION_DAYS` (default 30) by a background job (`TALLY_RAW_RETENTION_CLEANUP_INTERVAL_MIN`, default 60; `0` disables). Financial payloads are never written to application logs.

---

## 7. API reference

### Frontend (JWT Bearer — WhizUnik user token)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/integrations/tally/pairing-code` | Generate one-time pairing code `{ code, expiresAt, expiresInMinutes }` |
| GET | `/api/integrations/tally/status` | Connection state, connectors, companies, current sync, last sync — no secrets |
| GET | `/api/integrations/tally/connectors` | Connector list |
| GET | `/api/integrations/tally/sync-history?connectorId&status&limit` | Session history |
| GET | `/api/integrations/tally/audit?limit` | Recent audit events |
| POST | `/api/integrations/tally/disconnect` | Revoke connector `{ connectorId }` |

### Connector (see §3 headers)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/integrations/tally/connect` | Pairing-code exchange (public, rate-limited per IP) |
| POST | `/api/integrations/tally/heartbeat` | Liveness + pending command pickup |
| GET | `/api/integrations/tally/config?companyId=` | Sync config: entity settings, batch limits, checkpoints, report definitions |
| POST | `/api/integrations/tally/sync/start` | `{ companyId, entityType, syncType, totalRecords?, totalBatches? }` → `syncId` |
| POST | `/api/integrations/tally/sync/batch` | Batch upload → deterministic ACK |
| POST | `/api/integrations/tally/sync/complete` | `{ syncId, lastObjectId?, lastVoucherDate?, lastVoucherNumber? }` |
| POST | `/api/integrations/tally/sync/error` | `{ syncId, errorMessage, recoverable? }` |

### Error codes

Every error: `{ "success": false, "error": { "code", "message" }, "requestId" }`

| Code | HTTP |
|---|---|
| AUTHENTICATION_FAILED | 401 |
| AUTHORIZATION_FAILED | 403 |
| INVALID_PAYLOAD / INVALID_COMPANY / INVALID_BATCH | 400 |
| DUPLICATE_BATCH / DUPLICATE_RECORD | 409 |
| TALLY_DATA_INVALID / NORMALIZATION_FAILED | 422 |
| RATE_LIMITED | 429 |
| DATABASE_ERROR / SERVER_ERROR | 500 |

---

## 8. Database models (new tables)

`tally_companies`, `tally_connectors`, `tally_pairing_codes`, `tally_sync_sessions`, `tally_batches`, `tally_source_records`, `tally_raw_records`, `tally_sync_checkpoints`, `tally_audit_logs`, `suppliers`, `products`, `tally_ledgers`, `purchase_invoices`, `tally_vouchers`, `tally_reports`, `tally_sync_commands`.

Schema lives in `backend/src/db/tallySchema.ts` (idempotent, runs on every startup, tracked as migration `v4_tally_integration`).

---

## 9. Environment variables

```bash
# Pairing
TALLY_PAIRING_CODE_TTL_MINUTES=10
TALLY_PAIRING_MAX_ATTEMPTS=5

# Batch limits
TALLY_BATCH_MAX_RECORDS=500
TALLY_BATCH_MAX_BYTES=2097152

# Rate limiting (per connector unless noted)
TALLY_RATE_BATCH_PER_MIN=120
TALLY_RATE_HEARTBEAT_PER_MIN=60
TALLY_RATE_CONNECT_PER_HOUR=10        # per IP
TALLY_RATE_PAIRING_PER_10MIN=5        # per IP
TALLY_RATE_DEFAULT_PER_MIN=240

# Security
TALLY_HMAC_REQUIRED=false
TALLY_REQUEST_TIMESTAMP_WINDOW_SEC=300
TALLY_HEARTBEAT_STALE_MINUTES=10

# Raw storage retention
TALLY_RAW_RETENTION_DAYS=30
TALLY_RAW_RETENTION_CLEANUP_INTERVAL_MIN=60   # 0 disables the job

# Misc
TALLY_DISABLED_ENTITY_TYPES=          # comma-separated entity types to disable
PUBLIC_API_BASE_URL=                  # advertised to connectors in /connect response
```

---

## 10. Exact connector implementation guide

Base URL: the WhizUnik API root (e.g. `https://excel.frillchills.com/api` — HTTPS mandatory in production).

1. **Pair:** show an input for the code from the WhizUnik UI, then `POST /integrations/tally/connect` with `{ pairingCode, connectorName, deviceName, deviceId, appVersion, companies: [{ guid, name }] }`. Store `connectorId`, `accessToken`, `hmacSecret` securely (DPAPI on Windows); they are never re-issued.
2. **Heartbeat:** `POST /integrations/tally/heartbeat` every `heartbeatIntervalSeconds`; inspect `commands` for cloud-directed actions.
3. **Fetch config:** `GET /integrations/tally/config?companyId=…`; iterate `entities` in `syncOrder`, skipping disabled ones.
4. **For each entity type:** `POST /sync/start` → read data from TallyPrime (port 9000, localhost only) using the incremental field from the config/checkpoints → upload in batches of `batchLimits.maxRecords` → `POST /sync/complete` with the last object's identity fields. On a fatal error call `POST /sync/error`.
5. **Retry semantics:** on network failure or HTTP 429 (honor `Retry-After`), resend the same batch unchanged — the server replays the stored ACK for duplicates. Always send a fresh `X-Request-Id` per HTTP attempt, and a fresh `X-Timestamp`.
6. **Payload rules:** one voucher per record with `voucherType`, `voucherNumber`, `voucherDate`, `partyName`, `amount`, and a free-form `data` object; masters need `data.name` (and `partyType` for party ledgers). Include `tallyGuid`/`sourceObjectId` whenever Tally provides one — it makes dedup bulletproof.
7. **Never** expose Tally's port 9000 to the network; the connector is the only process that talks to Tally, and all cloud traffic is outbound HTTPS.

---

## 11. Deployment

1. Set the env vars above (plus existing `JWT_SECRET`, `PORT`, `FRONTEND_URL`, `DATABASE_URL`) in `backend/.env` or `ecosystem.config.cjs`.
2. `cd backend && npm run build && npm start` (PM2: `pm2 start ecosystem.config.cjs`). Single instance only.
3. Terminate HTTPS at the reverse proxy (nginx/Caddy/ALB). The connector only needs outbound 443.
4. Docker: `docker-compose up -d` — the tally schema auto-creates on boot.
5. Verify: `GET /api/health`, then pair from the UI and watch `GET /api/integrations/tally/status`.

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| 401 `AUTHENTICATION_FAILED` on connector calls | Wrong token/connector id, revoked connector, stale `X-Timestamp`, or replayed `X-Request-Id`. Re-pair if needed. |
| 429 RATE_LIMITED | Connector exceeding limits — honor `Retry-After`, raise env limits if under-provisioned. |
| 400 INVALID_BATCH `already running` | A session for that entity is active — complete/error it first or reuse the `activeSyncId` from `details`. |
| 400 INVALID_COMPANY | Company row doesn't belong to the connector's tenant — re-check the `companyId` from `/config`. |
| Records counted as `failed` | Missing identity fields — vouchers need `voucherType/voucherNumber/voucherDate` or a GUID; masters need `data.name`. Check server log `[tally][batch] Record failed (…)` (no payload contents are logged). |
| Frontend shows Offline | Heartbeat older than `TALLY_HEARTBEAT_STALE_MINUTES` — check the connector machine's outbound connectivity. |

## 13. Known limitations

- Single-process (sql.js in-memory SQLite): no horizontal scaling; large tenants → migrate to Postgres/better-sqlite3 (schema portable).
- HMAC verification uses the stored hash as key material rather than the raw secret (connector must re-present signatures derived from the original secret; documented in code).
- Replay cache and rate limiter are in-memory (reset on restart) — acceptable for a single-instance deployment.
- Report sync is scaffolding: `tally_reports` storage + config plumbing exist, but Tally query XML templates must be supplied per TallyPrime version.
- Sales vouchers map to `invoices` only for standard party-ledger vouchers; unusual shapes land in `tally_vouchers`.
- Receipt allocation is FIFO by due date only; manual allocation UI is out of scope for v1.
