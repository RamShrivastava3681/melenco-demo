# How the Tally Integration Works — A Complete Walkthrough

This document explains **how** the WhizUnik ↔ TallyPrime integration actually works, step by step, in plain language. For exact API specs, headers, and env vars, see `TALLY_INTEGRATION.md`.

---

## 1. The big picture

TallyPrime runs on a customer's Windows PC. It has no cloud API, no OAuth, nothing. The only way in is a local XML gateway on port 9000 — which we must **never** expose to the internet.

So the architecture is **pull-from-the-inside**, not push-from-the-outside:

```
┌─────────────────────────────────┐        ┌──────────────────────────────────┐
│  Customer's Windows PC          │        │  WhizUnik Cloud                  │
│                                 │        │                                  │
│  TallyPrime ◄──► Local          │  HTTPS │  Tally Integration API           │
│  (port 9000,    Connector       │ ─────► │   1. Validate                    │
│  localhost      (our software)  │ (out-  │   2. Deduplicate                 │
│  only)          sends data      │ bound) │   3. Normalize                   │
│                                 │        │   4. Store                       │
└─────────────────────────────────┘        └──────────────────────────────────┘
```

Key idea: the connector is a small program we install on the customer's PC. It reads from Tally locally and **pushes** data to WhizUnik over normal outbound HTTPS (port 443). WhizUnik never needs to reach into the customer's machine — no port forwarding, no static IP, no firewall changes. Even a customer behind strict office NAT works fine.

---

## 2. Who is who

| Piece | Where it runs | What it does |
|---|---|---|
| **TallyPrime** | Customer PC | The accounting software. Exposes a local XML API on port 9000. |
| **Local connector** | Customer PC | Our program. Logs into Tally locally, reads new data, uploads it to WhizUnik. |
| **Pairing code** | Shown in WhizUnik UI | A short, one-time password (e.g. `WZK-84F7-291A`) that "introduces" the connector to the customer's account. |
| **Connector credentials** | Stored on customer PC | `connectorId` + `accessToken` (+ optional HMAC secret). Like a username + API key for the connector. |
| **Sync session** | Cloud-side record | One run of syncing one entity type (e.g. "all sales vouchers"). Tracks progress and counts. |
| **Batch** | HTTP request | Up to 500 records sent in one request. |
| **Checkpoints** | Cloud-side record | "Where we left off" per data type — so the next sync only fetches what's new. |

---

## 3. Getting connected (pairing)

The customer does this once per PC:

**Step 1 — User generates a pairing code.**
In WhizUnik: Settings → Integrations → Tally → **Connect Tally**. The frontend calls the backend, which creates a code like `WZK-84F7-291A` and shows it on screen.

Behind the scenes:
- The code is random, using only unambiguous characters (no O/0, no I/1).
- The backend stores only a **SHA-256 hash** of the code. If the database leaked, the codes would be useless.
- It expires after 10 minutes (`TALLY_PAIRING_CODE_TTL_MINUTES`) and works exactly once.

**Step 2 — User types the code into the connector.**
The connector (installed on the same PC as Tally) asks for the code on first launch. When the user enters it, the connector calls `POST /api/integrations/tally/connect` with the code plus details about itself: device name, app version, and the list of Tally companies it found on the machine.

**Step 3 — Backend validates and registers.**
The backend:
1. Hashes the submitted code and looks it up — if no match, wrong tenant, already used, or expired → rejected (401).
2. Creates a **connector record** bound to *that user's* tenant. This is the crucial security step: the pairing code belongs to exactly one WhizUnik account, so the connector inherits exactly that account. Nobody can inject a different tenant.
3. Generates credentials: a public `connectorId` (like `tc_wdGIqDzzLuihbwFz`) and a secret `accessToken`. Only hashes are stored in the database — the plaintext is returned **once**, in this response, and never again.
4. Maps the reported Tally companies into `tally_companies` (this is how the cloud learns "guid-1111 = Test Company Ltd").
5. Returns the connector's **configuration**: which entity types to sync, in what order, batch size limits, and any existing checkpoints.

**Step 4 — Connector stores credentials and starts working.**
The connector saves the token securely on the Windows machine (e.g. DPAPI) and begins its heartbeat + sync cycle.

> Why not just an API key typed into the frontend? Because the secret would then live in browser code — the pairing code keeps permanent secrets out of the frontend entirely. The code is short-lived, single-use, and hashed at rest.

---

## 4. Staying connected (heartbeat)

Every couple of minutes the connector calls `POST /api/integrations/tally/heartbeat`.

This does three things:
1. **Tells the cloud it's alive.** The backend stamps `last_heartbeat` on the connector. If the heartbeat is older than 10 minutes, the frontend card shows "Offline".
2. **Picks up commands.** The cloud can leave pending instructions (e.g. "resync stock items") that the connector retrieves and executes.
3. **Keeps the connector ONLINE** so the WhizUnik dashboard shows live status.

---

## 5. The sync cycle (the core loop)

For each Tally company and each entity type (ledgers, sales vouchers, receipts, stock items…), the connector runs this loop:

```
1. sync/start     → "I'm about to send SALES_VOUCHER data"
2. sync/batch ×N  → "Here are records 1–500", "here are 501–1000", …
3. sync/complete  → "Done. The newest record was INV-00452 dated 2026-07-14"
```

### Step 1 — Start: `POST /sync/start`

The connector says: company X, entity type SALES_VOUCHER, sync type INCREMENTAL_SYNC.

The backend:
- Verifies the company belongs to this connector's tenant (if not → `INVALID_COMPANY`, 400).
- Checks there's no already-running session for the same company+entity (if there is → rejected with the active `syncId` in the error details, so the connector can resume it instead).
- Creates a **sync session** with a fresh `syncId` (e.g. `sync_ab12cd34…`) and status `RUNNING`.

### Step 2 — Upload: `POST /sync/batch`

The connector reads records from Tally (using the checkpoint from `/config` to know where it left off) and sends them in batches. Each record looks like:

```json
{
  "tallyGuid": "REMOTEGUID-abc123",        // Tally's own id, if it has one
  "voucherType": "Sales",
  "voucherNumber": "INV-00451",
  "voucherDate": "2026-07-14",
  "partyName": "Acme Traders",
  "amount": 11800.00,
  "data": { "dueDate": "2026-08-13", "narration": "..." }   // free-form extras
}
```

For every batch the backend runs a pipeline:

```
validate envelope → authorize (tenant/company/session) → store raw copy
      → for each record: resolve identity → dedupe → normalize → persist
      → update counters → return deterministic ACK
```

The ACK is always the same shape, and it's the contract for retries:

```json
{
  "success": true,
  "syncId": "sync_ab12cd34…",
  "batchNumber": 3,
  "accepted": 498,
  "duplicates": 2,
  "failed": 0,
  "nextBatch": 4
}
```

- `accepted` — records newly created or updated in WhizUnik.
- `duplicates` — records we'd already seen, identical, so we ignored them (this is normal, not an error).
- `failed` — records that couldn't be processed (e.g. a voucher with no date and no GUID). The batch still succeeds; only the bad record is skipped, and the reason is logged server-side (never the financial payload itself).

### Step 3 — Finish: `POST /sync/complete`

The connector reports the last record it sent. The backend:
- Sets the session's final status: `COMPLETED` (no failures) or `PARTIAL` (some records failed).
- Saves the **checkpoint** for that company+entity: `lastVoucherNumber: INV-00452, lastVoucherDate: 2026-07-14`. Next incremental sync starts from there.
- Updates the connector's `last_sync` / `last_successful_sync` timestamps, which the dashboard shows.

If the connector crashes mid-sync or Tally dies, it calls `POST /sync/error` (or simply disappears); the session ends as `FAILED` or `CANCELLED`, and the next sync starts fresh from the last checkpoint — nothing is lost, nothing is double-counted.

---

## 6. Why duplicates can never happen (idempotency)

Networks fail. The single most important guarantee is: **the same Tally record can be uploaded any number of times and it will exist exactly once in WhizUnik.**

Three layers make that true:

**Layer 1 — source identity.**
Every record gets a unique identity key:
`tenantId + companyId + "tally" + entityType + sourceObjectId`

- If Tally provided a GUID, that's `sourceObjectId`.
- If not (older Tally versions don't for vouchers), we build a deterministic fingerprint from stable fields: `sha256(voucherType | voucherNumber | voucherDate | partyName)`. Same voucher → same fingerprint → same identity, no matter when or how often it's uploaded.
- This identity lives in `tally_source_records` with a UNIQUE constraint. Even two simultaneous uploads can't both insert (the second gets counted as a duplicate).

**Layer 2 — content hashing.**
Each record's content is hashed. If a record arrives whose identity exists *and* whose content hash matches → identical retransmission → counted as `duplicates`, zero writes. If the content differs (Tally edited the voucher), we update the WhizUnik record — but never overwrite the original source ids.

**Layer 3 — batch ACK replay.**
Each processed batch's ACK is stored. If the connector resends batch 3 because it never got the response for batch 3 (classic network failure), the backend sees "batch 3 already processed" and **replays the stored ACK byte-for-byte** without touching the data. The connector stays perfectly in sync with what the cloud knows.

This is also true across sessions: a retried batch on a completed session still replays its ACK; only *new* batches require a RUNNING session.

---

## 7. Where the data goes (normalization)

Raw Tally XML is messy. The connector pre-shapes records; the cloud then maps each entity type into the right WhizUnik table:

| Tally thing | Lands in | Notes |
|---|---|---|
| Sales voucher | **invoices** | Party ledger → customer (created on the fly if new). Due date, amount, balance populated. |
| Receipt voucher | **payments** + **payment_allocations** | Auto-allocated FIFO against the customer's open invoices; closes invoices whose balance hits zero — exactly like manual payment application in WhizUnik. |
| Purchase voucher | **purchase_invoices** | Party → supplier. |
| Stock item | **products** | |
| Party ledger (debtor) | **customers** | |
| Party ledger (creditor) | **suppliers** | |
| Other ledgers/groups/units/godowns | **tally_ledgers** | Chart-of-accounts style store. |
| Every other voucher type (journal, contra, debit note, orders…) | **tally_vouchers** | Generic store that keeps the full original JSON — nothing is ever dropped. |
| Reports (balance sheet, GST…) | **tally_reports** | Scaffolded; query templates are configurable, never hardcoded guesses. |

Two invariants:
1. **Before** touching any normalized table, the original record is saved to `tally_raw_records` (a staging copy). If we ever mis-normalize something, we can reprocess from raw. Raw copies are auto-purged after 30 days.
2. **Original Tally identifiers are preserved forever** in `tally_source_records` — you can always trace any WhizUnik invoice back to its exact Tally voucher.

---

## 8. Who's allowed to do what (security)

Every connector request passes this gauntlet:

1. **Token check** — the `Authorization: Bearer` token must hash to the stored hash (constant-time compare, no timing leaks). Wrong → 401.
2. **Revocation check** — a revoked connector is dead instantly, even with a valid token. → 401.
3. **Timestamp window** — `X-Timestamp` must be within ±5 minutes. A request captured an hour ago can't be resent later. → 401.
4. **Replay check** — every `X-Request-Id` may be used once. A captured request replayed verbatim is rejected. → 401.
5. **Optional HMAC** — with `TALLY_HMAC_REQUIRED=true`, requests must also carry an HMAC-SHA256 signature over the request, so even a network intercept can't forge one.
6. **Tenant isolation** — the tenant comes from the connector record in our database, never from the request body. A connector for tenant A physically cannot write into tenant B: session lookups, company lookups, and every insert are scoped by the tenant derived from its credentials. Verified by tests.
7. **Rate limiting** — per-connector limits (batches: 120/min, heartbeats: 60/min by default) plus per-IP limits on public endpoints (pairing attempts, connect). Exceeding → 429 with `Retry-After`; the connector safely retries later.
8. **Validation** — every payload passes Zod schema validation before any logic runs. Malformed → 400 with structured error codes.

Every security-relevant event (connect, revoke, auth failures, batch accept/reject, sync start/complete/fail) is written to `tally_audit_logs` with tenant, connector, syncId, requestId, and timestamp — an auditable trail without ever logging financial payloads.

---

## 9. What the user sees

The WhizUnik dashboard (Dashboard → TallyPrime Integration card):

- **Before connecting:** a "Connect Tally" button → generates the pairing code with a live countdown.
- **After connecting:** connector name, device, version, online/offline badge (heartbeat freshness), last heartbeat / last sync times, and the mapped Tally companies.
- **During a sync:** a live progress bar — records processed / total, batches done, failed count — refreshed every 15 seconds from `/status`.
- **Disconnect:** one click revokes the connector. Its token stops working immediately, active syncs are cancelled, and the event is audited.

The frontend only ever receives connector metadata — tokens and HMAC secrets are never sent to the browser.

---

## 10. A complete worked example

Let's follow one invoice, end to end:

1. **User** clicks Connect Tally in WhizUnik → gets code `WZK-84F7-291A`.
2. **Connector** (on the PC with Tally) receives the code → `POST /connect` → stores `connectorId: tc_abc…`, `accessToken: xxx…`.
3. **Connector** heartbeats every 2 minutes. Dashboard shows Online.
4. **Connector** reads `/config`: "sync LEDGER first, then SALES_VOUCHER; batches ≤ 500; SALES_VOUCHER checkpoint = none" (first run).
5. **Connector** → `POST /sync/start` `{entityType: SALES_VOUCHER, syncType: INITIAL_SYNC}` → gets `syncId`.
6. **Connector** pulls 1,240 vouchers from Tally locally, uploads as 3 batches (500 + 500 + 240).
7. **Batch 1** ACK: `accepted: 499, duplicates: 0, failed: 1` — one voucher had no date and no GUID; it's logged server-side, everything else landed in `invoices`, and its customers were auto-created.
8. **Connection drops** during batch 2. The connector retries batch 2 unchanged. The backend replays the stored ACK — no double insert.
9. **Batch 3** ACK: `accepted: 240`. → `POST /sync/complete` `{lastVoucherNumber: "INV-01240", lastVoucherDate: "2026-07-14"}`.
10. **Session** = COMPLETED (1,239 accepted, 1 failed). Checkpoint saved. Next sync only asks Tally for vouchers after that point.
11. A receipt voucher arrives from Tally next cycle → matched FIFO against the open invoice for that customer → invoice shows "closed" in WhizUnik, with a payment allocation — same as if the user had applied the payment by hand.
12. **User** sees all of it in the dashboard: last sync 2 minutes ago, 1,239 records, zero action needed.

---

## 11. What happens when things go wrong

| Failure | What happens | Why it's safe |
|---|---|---|
| Network drops mid-batch | Connector resends the same batch | ACK replay returns the same response; no duplicates |
| Connector crashes mid-sync | Session stays RUNNING until next start attempt, then connector calls sync/error or the session is superseded | Checkpoint from the last *completed* session is the resume point |
| One bad record in a batch | Counted as `failed`, rest of batch proceeds | Batch-level success, record-level isolation; reason logged without payload |
| Whole sync fails (Tally offline) | Connector reports sync/error → session FAILED | Next sync retries from the last checkpoint; nothing half-written |
| Pairing code leaked | Expires in 10 min, single-use, useless after first connect | Even if someone sees the code, connecting first invalidates it |
| Connector stolen/cloned | Valid token alone fails replay checks; admin revokes from UI | Revocation is instant and audited |
| Someone floods the API | 429 + Retry-After | Per-connector and per-IP limits protect the platform |
| Wrong tenant data sent | Rejected 403/400 before any write | Tenant derived from connector record, not payload |

---

## 12. Quick reference — what lives where (backend)

```
backend/src/integrations/tally/
├── index.ts                  # mounts routers, assigns request ids
├── constants.ts              # entity types, sync types, limits
├── errors.ts                 # error codes → HTTP status mapping
├── routes/
│   ├── connector.routes.ts   # connect, heartbeat, config, sync/*  (connector auth)
│   └── status.routes.ts      # pairing-code, status, history, disconnect (JWT auth)
├── middleware/
│   ├── connectorAuth.ts      # token + timestamp + replay + HMAC checks
│   └── rateLimiter.ts        # sliding-window limiter, 429 + Retry-After
├── services/
│   ├── pairing.service.ts    # code create/consume (hashed, single-use)
│   ├── connector.service.ts  # registration, credentials, heartbeat, revoke
│   ├── company.service.ts    # Tally company registry + ownership checks
│   ├── syncSession.service.ts# sessions: start/counters/complete/fail
│   ├── batch.service.ts      # the ingestion pipeline + idempotency
│   ├── checkpoint.service.ts # incremental resume points
│   ├── rawStore.service.ts   # staging copies + retention purge
│   ├── config.service.ts     # config served to connectors
│   ├── status.service.ts     # dashboard payloads
│   └── audit.service.ts      # audit trail
├── normalizers/
│   ├── registry.ts           # entityType → normalizer dispatch
│   ├── masters.ts            # ledgers/stock/parties → customers, suppliers, products…
│   └── vouchers.ts           # sales→invoices, receipt→payments, rest→tally_vouchers
├── validators/schemas.ts     # zod schemas for everything
└── utils/                    # crypto (token/HMAC/pairing), env config, logger
```

All of this is verified by 34 passing tests (`cd backend && npm test`) covering pairing, auth, tenant isolation, idempotency, retries, partial failures, revocation, concurrency, and the complete end-to-end flow.
