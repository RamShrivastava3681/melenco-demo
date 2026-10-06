import { Router, Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import crypto from "node:crypto";
import db from "../../../db/index.js";
import {
  wzConnectSchema,
  wzTokenSchema,
  wzBatchSchema,
  wzHeartbeatSchema,
  wzUpdatesSchema,
  wzAdminPairingSchema,
  wzPushCommandSchema,
  wzAckCommandSchema,
  wzPushInvoicesSchema,
  formatWzIssues,
} from "./validate.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  sha256,
  sendWzError,
  wzAuthMiddleware,
  traceRequestId,
  requireHttpsIfConfigured,
  wzRateLimit,
  type AccessClaims,
} from "./auth.js";
import { generatePairingCode } from "../utils/crypto.js";
import { requireAuth } from "../../../middleware/auth.js";
import { publicApiBaseUrl, WHIZUNIK_PROTOCOL_VERSION } from "./baseUrl.js";

const router = Router();

router.use(traceRequestId, requireHttpsIfConfigured);

function newConnectorId(): string {
  return `wz-connector-${crypto.randomBytes(4).toString("hex")}`;
}

function newCompanyId(): string {
  return `whiz-company-${crypto.randomBytes(3).toString("hex")}`;
}

function ensureTenant(id: string, name: string): { id: string; name: string } {
  const existing = db.prepare(`SELECT id, name FROM tenants WHERE id = ?`).get(id) as
    | { id: string; name: string }
    | undefined;
  if (existing) return existing;
  db.prepare(`INSERT INTO tenants (id, name) VALUES (?, ?)`).run(id, name);
  return { id, name };
}

function tenantNameFor(tenantId: string): string {
  const t = db.prepare(`SELECT name FROM tenants WHERE id = ?`).get(tenantId) as
    | { name: string }
    | undefined;
  if (t?.name) return t.name;
  // Bridge legacy users table (tenant == users.id in the existing app)
  try {
    const u = db.prepare(`SELECT name FROM users WHERE id = ?`).get(tenantId) as
      | { name: string }
      | undefined;
    if (u?.name) return u.name || "Tenant Name";
  } catch { /* users table may not exist in isolation */ }
  return "Tenant Name";
}

function ensureCompany(tenantId: string, name: string, tallyGuid?: string | null): { id: string; tallyGuid: string | null } {
  const guid = tallyGuid?.trim() ? tallyGuid.trim() : null;
  if (guid) {
    const byGuid = db.prepare(`SELECT id, tally_guid FROM companies WHERE tenant_id = ? AND tally_guid = ?`).get(
      tenantId, guid
    ) as { id: string; tally_guid: string | null } | undefined;
    if (byGuid) {
      if (name && name !== undefined) {
        try { db.prepare(`UPDATE companies SET name = ? WHERE id = ?`).run(name, byGuid.id); } catch { /* noop */ }
      }
      return { id: byGuid.id, tallyGuid: byGuid.tally_guid };
    }
  } else {
    const byName = db.prepare(`SELECT id, tally_guid FROM companies WHERE tenant_id = ? AND name = ? AND tally_guid IS NULL`).get(
      tenantId, name
    ) as { id: string; tally_guid: string | null } | undefined;
    if (byName) return { id: byName.id, tallyGuid: byName.tally_guid };
  }
  const id = newCompanyId();
  db.prepare(`INSERT INTO companies (id, tally_guid, tenant_id, name) VALUES (?, ?, ?, ?)`).run(
    id, guid, tenantId, name
  );
  return { id, tallyGuid: guid };
}

/**
 * Resolve the batch `companyId` to a real company row for this tenant.
 *
 * New connectors send the WhizUnik company id from the pairing response
 * (`companyMapping.whizunikCompanyId`). Older connectors send the Tally
 * GUID or the Tally company name instead (they never persisted the
 * mapping). Accept all three so upgrades never strand queued batches:
 *   1. exact companies.id match (new-spec)
 *   2. tally_guid match (legacy guid)
 *   3. name match (legacy name, incl. rows whose tally_guid IS NULL)
 */
function resolveBatchCompany(tenantId: string, companyIdInput: string): { id: string; tenant_id: string } | null {
  const byId = db.prepare(`SELECT id, tenant_id FROM companies WHERE id = ?`).get(companyIdInput) as
    | { id: string; tenant_id: string }
    | undefined;
  if (byId && byId.tenant_id === tenantId) return byId;

  const trimmed = companyIdInput.trim();
  if (trimmed) {
    const byGuid = db.prepare(`SELECT id, tenant_id FROM companies WHERE tenant_id = ? AND tally_guid = ?`).get(
      tenantId, trimmed
    ) as { id: string; tenant_id: string } | undefined;
    if (byGuid) return byGuid;

    const byName = db.prepare(`SELECT id, tenant_id FROM companies WHERE tenant_id = ? AND name = ?`).get(
      tenantId, trimmed
    ) as { id: string; tenant_id: string } | undefined;
    if (byName) return byName;
  }
  return null;
}

function issuePair(connectorId: string, deviceId: string, tenantId: string) {
  const access = signAccessToken(connectorId, deviceId, tenantId);
  const refresh = signRefreshToken(connectorId, deviceId, tenantId);
  db.prepare(`UPDATE connectors SET refresh_token_hash = ?, updated_at = datetime('now') WHERE connector_id = ?`).run(
    sha256(refresh), connectorId
  );
  return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt, refreshToken: refresh };
}

function connectResponse(connectorId: string, deviceId: string, tenantId: string, company: { id: string; tallyGuid: string | null }) {
  const pair = issuePair(connectorId, deviceId, tenantId);
  return {
    connectorId,
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    accessTokenExpiresAt: pair.accessTokenExpiresAt,
    tenant: { id: tenantId, name: tenantNameFor(tenantId) },
    companyMapping: { tallyCompanyGuid: company.tallyGuid, whizunikCompanyId: company.id },
  };
}

/** Look up a pairing code in the new table, then fall back to legacy tally_pairing_codes. */
function lookupPairingCode(code: string): {
  kind: "whizunik" | "legacy";
  tenantId: string;
  companyName?: string | null;
  tallyGuid?: string | null;
  expiresAt: string;
  usedAt?: string | null;
} | null {
  const wz = db.prepare(`SELECT code, tenant_id, company_name, tally_guid, expires_at, used_at FROM pairing_codes WHERE code = ?`).get(code) as
    | { code: string; tenant_id: string; company_name: string | null; tally_guid: string | null; expires_at: string; used_at: string | null }
    | undefined;
  if (wz) {
    return { kind: "whizunik", tenantId: wz.tenant_id, companyName: wz.company_name, tallyGuid: wz.tally_guid, expiresAt: wz.expires_at, usedAt: wz.used_at };
  }
  try {
    const legacy = db.prepare(`SELECT id, user_id, expires_at, used_at FROM tally_pairing_codes WHERE code_hash = ?`).get(
      sha256(code)
    ) as { id: string; user_id: string; expires_at: string; used_at: string | null } | undefined;
    if (legacy) {
      return { kind: "legacy", tenantId: legacy.user_id, expiresAt: legacy.expires_at, usedAt: legacy.used_at };
    }
  } catch { /* legacy table may not exist */ }
  return null;
}

function consumePairingCode(code: string, found: { kind: "whizunik" | "legacy"; tenantId: string }): void {
  if (found.kind === "whizunik") {
    db.prepare(`UPDATE pairing_codes SET used_at = datetime('now') WHERE code = ?`).run(code);
  } else {
    db.prepare(`UPDATE tally_pairing_codes SET used_at = datetime('now') WHERE code_hash = ?`).run(sha256(code));
  }
}

// ---------------------------------------------------------------------------
// Detection helpers: only handle the NEW desktop-connector shape here.
// Everything else falls through (next()) to the legacy connector router so
// existing integrations and tests keep working unchanged.
// ---------------------------------------------------------------------------

function isNewConnectBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.companies)) return false; // legacy shape
  if (b.protocolVersion !== undefined) return true;
  if (b.company && typeof b.company === "object" && !Array.isArray(b.company)) return true;
  return false;
}

function hasLegacyConnectorHeaders(req: Request): boolean {
  return typeof req.headers["x-connector-id"] === "string" && (req.headers["x-connector-id"] as string).length > 0;
}

function isNewBatchBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return b.batchId !== undefined || b.requestId !== undefined;
}

// ===========================================================================
// 1. POST /connect — pairing-code exchange (public, per-IP rate limited)
// ===========================================================================

router.post(
  "/connect",
  wzRateLimit(60 * 60_000, 60, (req) => `wz-connect|${req.ip || "unknown"}`),
  (req: Request, res: Response, next: NextFunction) => {
    if (!isNewConnectBody(req.body)) {
      next(); // legacy connector — handled by connector.routes.ts
      return;
    }
    const parsed = wzConnectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
      return;
    }
    const input = parsed.data;
    try {
      const found = lookupPairingCode(input.pairingCode);
      if (!found) {
        sendWzError(res, "AUTHENTICATION_FAILED", "Invalid pairing code");
        return;
      }
      if (found.usedAt) {
        sendWzError(res, "AUTHENTICATION_FAILED", "Pairing code already used");
        return;
      }
      if (new Date(found.expiresAt).getTime() < Date.now()) {
        sendWzError(res, "AUTHENTICATION_FAILED", "Pairing code expired — generate a new one");
        return;
      }

      ensureTenant(found.tenantId, tenantNameFor(found.tenantId));
      const company = ensureCompany(found.tenantId, input.company.name, input.company.tallyGuid ?? found.tallyGuid ?? undefined);

      const connectorId = newConnectorId();
      db.prepare(
        `INSERT INTO connectors (id, connector_id, device_id, device_name, tenant_id, status, app_version, protocol_version)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
      ).run(uuidv4(), connectorId, input.deviceId, input.deviceName, found.tenantId, input.appVersion, input.protocolVersion);

      consumePairingCode(input.pairingCode, found);

      try {
        db.prepare(
          `INSERT INTO tally_audit_logs (id, user_id, connector_id, event, detail)
           VALUES (?, ?, ?, 'CONNECTOR_CONNECTED', ?)`
        ).run(
          uuidv4(),
          found.tenantId,
          connectorId,
          JSON.stringify({ deviceName: input.deviceName, appVersion: input.appVersion, protocol: "whizunik" })
        );
      } catch { /* audit must never break connect */ }

      res.status(200).json(connectResponse(connectorId, input.deviceId, found.tenantId, company));
    } catch (err) {
      console.error("[whizunik][connect] failed:", err);
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
    }
  }
);

// ===========================================================================
// 2. POST /token — refresh access token (public, per-IP rate limited)
// ===========================================================================

router.post(
  "/token",
  wzRateLimit(60 * 60_000, 120, (req) => `wz-token|${req.ip || "unknown"}`),
  (req: Request, res: Response) => {
    const parsed = wzTokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
      return;
    }
    const input = parsed.data;
    try {
      let claims;
      try {
        claims = verifyRefreshToken(input.refreshToken);
      } catch (e: unknown) {
        const code = (e as { code?: string })?.code === "TOKEN_EXPIRED" ? "TOKEN_EXPIRED" : "AUTHENTICATION_FAILED";
        sendWzError(res, code as "TOKEN_EXPIRED" | "AUTHENTICATION_FAILED", (e as Error)?.message || "Invalid refresh token");
        return;
      }
      if (claims.connectorId !== input.connectorId || claims.deviceId !== input.deviceId) {
        sendWzError(res, "AUTHENTICATION_FAILED", "Refresh token does not match connector or device");
        return;
      }
      const row = db.prepare(`SELECT connector_id, device_id, tenant_id, refresh_token_hash FROM connectors WHERE connector_id = ?`).get(
        input.connectorId
      ) as { connector_id: string; device_id: string | null; tenant_id: string; refresh_token_hash: string | null } | undefined;
      if (!row || !row.refresh_token_hash || row.refresh_token_hash !== sha256(input.refreshToken)) {
        sendWzError(res, "AUTHENTICATION_FAILED", "Invalid refresh token");
        return;
      }

      // Company mapping: latest company for this tenant (or the one from the last batch)
      const company = db.prepare(`SELECT id, tally_guid FROM companies WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`).get(
        row.tenant_id
      ) as { id: string; tally_guid: string | null } | undefined;
      const mapping = company ?? { id: "", tally_guid: null };

      const pair = issuePair(row.connector_id, row.device_id || input.deviceId, row.tenant_id);
      res.status(200).json({
        connectorId: row.connector_id,
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        accessTokenExpiresAt: pair.accessTokenExpiresAt,
        tenant: { id: row.tenant_id, name: tenantNameFor(row.tenant_id) },
        companyMapping: { tallyCompanyGuid: mapping.tally_guid, whizunikCompanyId: mapping.id },
      });
    } catch (err) {
      console.error("[whizunik][token] failed:", err);
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
    }
  }
);

// ===========================================================================
// 3. POST /sync/batch — idempotent batch ingest (Bearer access token)
// ===========================================================================

router.post(
  "/sync/batch",
  wzRateLimit(60_000, 240, (req) => {
    const h = req.headers.authorization || "";
    return `wz-batch|${h.slice(0, 32) || req.ip || "unknown"}`;
  }),
  (req: Request, res: Response, next: NextFunction) => {
    if (hasLegacyConnectorHeaders(req) && !isNewBatchBody(req.body)) {
      next(); // legacy connector — handled by connector.routes.ts
      return;
    }
    if (hasLegacyConnectorHeaders(req) && isNewBatchBody(req.body)) {
      // Mixed legacy headers + new body: prefer new-spec (Bearer only per spec,
      // but be lenient and accept the Bearer token when present).
    }
    wzAuthMiddleware(req, res, () => {
      const parsed = wzBatchSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
        return;
      }
      const input = parsed.data;
      const claims = (req as Request & { wzClaims?: AccessClaims }).wzClaims!;
      try {
        // Company must belong to the connector's tenant (tenant from token, never payload).
        // Accept the WhizUnik company id plus legacy Tally GUID / name fallbacks.
        const company = resolveBatchCompany(claims.tenantId, input.companyId);
        if (!company) {
          sendWzError(res, "INVALID_COMPANY", "Company not found for this account");
          return;
        }

        // Idempotency: batchId OR requestId seen before → replay stored ACK
        const existing = db.prepare(`SELECT batch_id, received_count FROM sync_batches WHERE batch_id = ? OR request_id = ?`).get(
          input.batchId, input.requestId
        ) as { batch_id: string; received_count: number } | undefined;
        if (existing) {
          res.status(200).json({ acked: true, batchId: existing.batch_id, duplicate: true, receivedCount: 0 });
          return;
        }

        const receivedCount = input.records.length;
        // Store the canonical company id so legacy GUID/name uploads land on
        // the same company row the platform shows (not the raw input string).
        const canonicalCompanyId = company.id;
        db.prepare(
          `INSERT INTO sync_batches (id, batch_id, request_id, sync_id, tenant_id, connector_id, company_id, entity_type, received_count, duplicate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
        ).run(uuidv4(), input.batchId, input.requestId, input.syncId, claims.tenantId, claims.connectorId, canonicalCompanyId, input.entityType, receivedCount);

        // Receive path: persist every record so the platform can show and
        // reconcile exactly what the connector pushed (per-record storage).
        const insertRecord = db.prepare(
          `INSERT INTO sync_records (id, batch_id, tenant_id, company_id, entity_type, source_object_id, source_voucher_number, source_voucher_date, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const r of input.records) {
          insertRecord.run(
            uuidv4(),
            input.batchId,
            claims.tenantId,
            canonicalCompanyId,
            r.entityType || input.entityType,
            r.sourceObjectId ?? null,
            r.sourceVoucherNumber ?? null,
            r.sourceVoucherDate ?? null,
            JSON.stringify(r)
          );
        }

        db.prepare(`UPDATE connectors SET last_sync = datetime('now'), updated_at = datetime('now') WHERE connector_id = ?`).run(claims.connectorId);

        res.status(200).json({ acked: true, batchId: input.batchId, duplicate: false, receivedCount });
      } catch (err: unknown) {
        const msg = (err as Error)?.message || "";
        if (msg.includes("UNIQUE constraint failed")) {
          // Concurrent duplicate insert — treat as idempotent replay
          try {
            const existing = db.prepare(`SELECT batch_id FROM sync_batches WHERE batch_id = ? OR request_id = ?`).get(
              input.batchId, input.requestId
            ) as { batch_id: string } | undefined;
            res.status(200).json({ acked: true, batchId: existing?.batch_id ?? input.batchId, duplicate: true, receivedCount: 0 });
          } catch {
            sendWzError(res, "SERVER_ERROR", "An internal error occurred");
          }
          return;
        }
        console.error("[whizunik][sync/batch] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    });
  }
);

// ===========================================================================
// 4. POST /heartbeat — liveness (Bearer access token) → 204 No Content
// ===========================================================================

router.post(
  "/heartbeat",
  wzRateLimit(60_000, 120, (req) => {
    const h = req.headers.authorization || "";
    return `wz-heartbeat|${h.slice(0, 32) || req.ip || "unknown"}`;
  }),
  (req: Request, res: Response, next: NextFunction) => {
    const body = req.body ?? {};
    const looksNew = typeof body === "object" && body !== null && (
      (body as Record<string, unknown>).protocolVersion !== undefined ||
      (body as Record<string, unknown>).connectorId !== undefined ||
      (body as Record<string, unknown>).status !== undefined ||
      typeof (body as Record<string, unknown>).tallyVersion === "string"
    );
    if (hasLegacyConnectorHeaders(req) && !looksNew) {
      next(); // legacy connector — handled by connector.routes.ts
      return;
    }
    wzAuthMiddleware(req, res, () => {
      const parsed = wzHeartbeatSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
        return;
      }
      const input = parsed.data;
      const claims = (req as Request & { wzClaims?: AccessClaims }).wzClaims!;
      // Ensure tallyVersion is always a string (never null) for the DB column
      const tallyVersion = input.tallyVersion ?? '';
      if (input.connectorId !== claims.connectorId) {
        sendWzError(res, "AUTHENTICATION_FAILED", "Connector mismatch");
        return;
      }
      try {
        db.prepare(
          `UPDATE connectors SET last_heartbeat = datetime('now'), app_version = ?, protocol_version = ?, tally_version = ?, status = 'active', updated_at = datetime('now')
           WHERE connector_id = ?`
        ).run(input.appVersion, input.protocolVersion, tallyVersion, claims.connectorId);
        if (input.status === "running" && input.currentSync) {
          db.prepare(`UPDATE connectors SET last_sync = datetime('now') WHERE connector_id = ?`).run(claims.connectorId);
        }
        res.status(204).send();
      } catch (err) {
        console.error("[whizunik][heartbeat] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    });
  }
);

// ===========================================================================
// 5. POST /updates — connector update check (public)
// ===========================================================================

router.post("/updates", (req: Request, res: Response) => {
  const parsed = wzUpdatesSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
    return;
  }
  const latest = process.env.WHIZUNIK_LATEST_CONNECTOR_VERSION || null;
  const downloadUrl = process.env.WHIZUNIK_CONNECTOR_DOWNLOAD_URL || null;
  const notes = process.env.WHIZUNIK_CONNECTOR_RELEASE_NOTES || null;
  if (latest && latest !== parsed.data.appVersion) {
    res.status(200).json({ updateAvailable: true, latestVersion: latest, downloadUrl, notes });
    return;
  }
  res.status(200).json({ updateAvailable: false, latestVersion: null, downloadUrl: null, notes: null });
});

// ===========================================================================
// Admin API — create pairing codes (WZK-XXXX-XXXX linked to tenant + company)
// JWT (WhizUnik user) or X-Admin-Key when ADMIN_API_KEY is configured.
// ===========================================================================

function adminKeyOk(req: Request): boolean {
  const configured = process.env.ADMIN_API_KEY;
  if (!configured) return false;
  return req.headers["x-admin-key"] === configured;
}

router.post("/admin/pairing-codes", (req: Request, res: Response) => {
  const proceed = () => {
    const parsed = wzAdminPairingSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
      return;
    }
    const input = parsed.data;
    try {
      // Resolve tenant: explicit id wins; otherwise derive from the JWT user.
      const jwtUser = (req as Request & { user?: { userId?: string } }).user;
      const tenantId = input.tenantId || jwtUser?.userId || `tenant-${crypto.randomBytes(4).toString("hex")}`;
      const tenantName = input.tenantName || tenantNameFor(tenantId);
      ensureTenant(tenantId, tenantName);

      const companyName = input.companyName || input.company || undefined;
      const tallyGuid = input.tallyGuid || input.tallyCompanyGuid || undefined;

      const ttlMinutes = input.ttlMinutes ?? 60;
      const code = generatePairingCode();
      const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
      db.prepare(
        `INSERT INTO pairing_codes (code, tenant_id, company_name, tally_guid, expires_at) VALUES (?, ?, ?, ?, ?)`
      ).run(code, tenantId, companyName ?? null, tallyGuid ?? null, expiresAt);

      res.status(201).json({ pairingCode: code, tenantId, expiresAt });
    } catch (err) {
      console.error("[whizunik][admin/pairing-codes] failed:", err);
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
    }
  };

  if (adminKeyOk(req)) {
    proceed();
    return;
  }
  requireAuth(req, res, proceed);
});

// ===========================================================================
// GET /info — public discovery: canonical API base URL + protocol info.
// The connector and setup guides always use this URL, never a default.
// ===========================================================================

router.get("/info", (_req: Request, res: Response) => {
  res.status(200).json({
    apiBaseUrl: publicApiBaseUrl(),
    protocolVersion: WHIZUNIK_PROTOCOL_VERSION,
    heartbeatIntervalSeconds: 120,
    endpoints: {
      connect: "/api/integrations/tally/connect",
      token: "/api/integrations/tally/token",
      batch: "/api/integrations/tally/sync/batch",
      heartbeat: "/api/integrations/tally/heartbeat",
      updates: "/api/integrations/tally/updates",
      pendingCommands: "/api/integrations/tally/commands/pending",
      ackCommand: "/api/integrations/tally/commands/ack",
    },
  });
});

// ===========================================================================
// Receive path (platform reads what connectors pushed — JWT auth)
// ===========================================================================

/** GET /sync/batches — batch history for this tenant (receive visibility). */
router.get("/sync/batches", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    try {
      const userId = req.user!.userId;
      const { companyId, entityType, limit } = req.query as Record<string, string | undefined>;
      const take = Math.min(Math.max(parseInt(limit || "25", 10) || 25, 1), 100);
      let sql = `SELECT batch_id, request_id, sync_id, connector_id, company_id, entity_type, received_count, duplicate, created_at
                 FROM sync_batches WHERE tenant_id = ?`;
      const params: unknown[] = [userId];
      if (companyId) {
        sql += ` AND company_id = ?`;
        params.push(companyId);
      }
      if (entityType) {
        sql += ` AND entity_type = ?`;
        params.push(entityType);
      }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(take);
      const batches = db.prepare(sql).all(...params);
      res.status(200).json({ batches });
    } catch (err) {
      console.error("[whizunik][sync/batches] failed:", err);
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
    }
  });
});

/** GET /received — individual records the platform received (paginated). */
router.get("/received", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    try {
      const userId = req.user!.userId;
      const { companyId, entityType, limit, offset } = req.query as Record<string, string | undefined>;
      const take = Math.min(Math.max(parseInt(limit || "50", 10) || 50, 1), 200);
      const skip = Math.max(parseInt(offset || "0", 10) || 0, 0);
      let sql = `SELECT id, batch_id, company_id, entity_type, source_object_id, source_voucher_number, source_voucher_date, payload, created_at
                 FROM sync_records WHERE tenant_id = ?`;
      const params: unknown[] = [userId];
      if (companyId) {
        sql += ` AND company_id = ?`;
        params.push(companyId);
      }
      if (entityType) {
        sql += ` AND entity_type = ?`;
        params.push(entityType);
      }
      sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params.push(take, skip);
      const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      const records = rows.map((r) => {
        let payload: unknown = null;
        try {
          payload = JSON.parse(r.payload as string);
        } catch {
          payload = r.payload;
        }
        return { ...r, payload };
      });
      res.status(200).json({ records, limit: take, offset: skip });
    } catch (err) {
      console.error("[whizunik][received] failed:", err);
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
    }
  });
});

// ===========================================================================
// Push path (platform → connector; outbound-only: queued, connector polls)
// ===========================================================================

/**
 * POST /commands — platform pushes a command to a connector (JWT auth).
 * The command is queued; the connector picks it up via GET /commands/pending
 * on its next outbound poll. Nothing ever dials in to the PC.
 */
router.post("/commands", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    const parsed = wzPushCommandSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
      return;
    }
    try {
      const userId = req.user!.userId;
      const row = db.prepare(`SELECT connector_id, tenant_id FROM connectors WHERE connector_id = ?`).get(
        parsed.data.connectorId
      ) as { connector_id: string; tenant_id: string } | undefined;
      if (!row || row.tenant_id !== userId) {
        sendWzError(res, "INVALID_COMPANY", "Connector not found for this account");
        return;
      }
      const id = `cmd_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
      db.prepare(
        `INSERT INTO connector_commands (id, tenant_id, connector_id, command, payload) VALUES (?, ?, ?, ?, ?)`
      ).run(id, userId, row.connector_id, parsed.data.command, JSON.stringify(parsed.data.payload ?? {}));
      const created = db.prepare(
        `SELECT id, connector_id, command, payload, status, created_at FROM connector_commands WHERE id = ?`
      ).get(id) as { id: string; connector_id: string; command: string; payload: string; status: string; created_at: string };
      res.status(201).json({
        id: created.id,
        connectorId: created.connector_id,
        command: created.command,
        payload: JSON.parse(created.payload),
        status: created.status,
        createdAt: created.created_at,
      });
    } catch (err) {
      console.error("[whizunik][commands] failed:", err);
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
    }
  });
});

/**
 * POST /invoices/push — queue selected platform invoices for Tally (JWT auth).
 * Loads invoices + customer names for this tenant, builds connector-ready
 * voucher payloads, and queues a single PUSH_VOUCHERS command. The connector
 * picks it up via GET /commands/pending and writes to Tally locally.
 */
router.post("/invoices/push", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    const parsed = wzPushInvoicesSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
      return;
    }
    try {
      const userId = req.user!.userId;
      const { connectorId, companyId, invoiceIds } = parsed.data;

      // Resolve connector: new-spec first, legacy tc_* as fallback.
      let pushTarget: { kind: "whizunik"; connectorId: string } | { kind: "legacy"; rowId: string; connectorId: string } | null = null;
      const conn = db.prepare(`SELECT connector_id, tenant_id FROM connectors WHERE connector_id = ?`).get(
        connectorId
      ) as { connector_id: string; tenant_id: string } | undefined;
      if (conn && conn.tenant_id === userId) {
        pushTarget = { kind: "whizunik", connectorId: conn.connector_id };
      } else {
        try {
          const legacy = db.prepare(
            `SELECT id, connector_id, user_id FROM tally_connectors WHERE connector_id = ?`
          ).get(connectorId) as { id: string; connector_id: string; user_id: string } | undefined;
          if (legacy && legacy.user_id === userId) {
            pushTarget = { kind: "legacy", rowId: legacy.id, connectorId: legacy.connector_id };
          }
        } catch { /* legacy table may not exist */ }
      }
      if (!pushTarget) {
        sendWzError(res, "INVALID_COMPANY", "Connector not found for this account");
        return;
      }
      const company = db.prepare(`SELECT id, name, tally_guid FROM companies WHERE id = ?`).get(
        companyId
      ) as { id: string; name: string; tally_guid: string | null } | undefined;
      if (!company) {
        // Fall back to legacy tally_companies for old connectors.
        try {
          const legacyCo = db.prepare(`SELECT id, tally_company_guid, tally_company_name FROM tally_companies WHERE id = ? AND user_id = ?`).get(
            companyId, userId
          ) as { id: string; tally_company_guid: string; tally_company_name: string } | undefined;
          if (!legacyCo) {
            sendWzError(res, "INVALID_COMPANY", "Company not found for this account");
            return;
          }
        } catch {
          sendWzError(res, "INVALID_COMPANY", "Company not found for this account");
          return;
        }
      }

      const uniqueIds = [...new Set(invoiceIds)];
      const placeholders = uniqueIds.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT i.id, i.invoice_number, i.issue_date, i.due_date, i.amount, i.balance, i.status,
                c.name AS customer_name
         FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id AND c.user_id = i.user_id
         WHERE i.user_id = ? AND i.id IN (${placeholders})`
      ).all(userId, ...uniqueIds) as Array<{
        id: string; invoice_number: string; issue_date: string; due_date: string;
        amount: number; balance: number; status: string; customer_name: string | null;
      }>;
      if (rows.length === 0) {
        sendWzError(res, "INVALID_PAYLOAD", "No matching invoices for this account");
        return;
      }
      const foundIds = new Set(rows.map((r) => r.id));
      const missing = uniqueIds.filter((id) => !foundIds.has(id));

      const vouchers = rows.map((r) => ({
        invoiceId: r.id,
        invoiceNumber: r.invoice_number,
        partyName: r.customer_name ?? "Unknown",
        amount: Number(r.amount),
        balance: Number(r.balance),
        issueDate: r.issue_date,
        dueDate: r.due_date,
        tallyDate: String(r.issue_date).slice(0, 10).replace(/-/g, ""),
        voucherType: "Sales",
        narration: `WhizUnik ${r.invoice_number} due ${r.due_date}`,
      }));

      const id = `cmd_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
      const payload = {
        companyId,
        companyName: company?.name ?? "",
        tallyCompanyGuid: company?.tally_guid ?? null,
        vouchers,
      };
      const payloadJson = JSON.stringify(payload);
      if (pushTarget.kind === "whizunik") {
        db.prepare(
          `INSERT INTO connector_commands (id, tenant_id, connector_id, command, payload) VALUES (?, ?, ?, 'PUSH_VOUCHERS', ?)`
        ).run(id, userId, pushTarget.connectorId, payloadJson);
      } else {
        db.prepare(
          `INSERT INTO tally_sync_commands (id, user_id, connector_id, command, payload) VALUES (?, ?, ?, 'PUSH_VOUCHERS', ?)`
        ).run(id, userId, pushTarget.rowId, payloadJson);
      }
      res.status(201).json({
        id,
        connectorId: pushTarget.connectorId,
        command: "PUSH_VOUCHERS",
        status: "PENDING",
        createdAt: new Date().toISOString(),
        voucherCount: vouchers.length,
        missingInvoiceIds: missing,
        vouchers,
      });
    } catch (err) {
      console.error("[whizunik][invoices/push] failed:", err);
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
    }
  });
});

/**
 * GET /commands — recent push commands for this tenant (JWT auth).
 * Used by the platform UI to show Queued → Delivered → Done/Cancelled.
 */
router.get("/commands", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    try {
      const userId = req.user!.userId;
      const { connectorId, limit } = req.query as Record<string, string | undefined>;
      const take = Math.min(Math.max(parseInt(limit || "20", 10) || 20, 1), 100);
      let sql = `SELECT id, connector_id, command, payload, status, created_at, delivered_at, completed_at
                 FROM connector_commands WHERE tenant_id = ?`;
      const params: unknown[] = [userId];
      if (connectorId) {
        sql += ` AND connector_id = ?`;
        params.push(connectorId);
      }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(take);
      const rows = db.prepare(sql).all(...params) as Array<{
        id: string; connector_id: string; command: string; payload: string;
        status: string; created_at: string; delivered_at: string | null; completed_at: string | null;
      }>;
      // Merge legacy tally_sync_commands so old connectors' pushes show too.
      try {
        let legacySql = `SELECT tc.id, tcc.connector_id AS public_id, tc.command, tc.payload, tc.status, tc.created_at, tc.delivered_at, tc.completed_at
                         FROM tally_sync_commands tc JOIN tally_connectors tcc ON tcc.id = tc.connector_id
                         WHERE tc.user_id = ?`;
        const legacyParams: unknown[] = [userId];
        if (connectorId) {
          legacySql += ` AND tcc.connector_id = ?`;
          legacyParams.push(connectorId);
        }
        legacySql += ` ORDER BY tc.created_at DESC LIMIT ?`;
        legacyParams.push(take);
        const legacyRows = db.prepare(legacySql).all(...legacyParams) as Array<{
          id: string; public_id: string; command: string; payload: string;
          status: string; created_at: string; delivered_at: string | null; completed_at: string | null;
        }>;
        for (const lr of legacyRows) {
          rows.push({
            id: lr.id, connector_id: lr.public_id, command: lr.command, payload: lr.payload,
            status: lr.status, created_at: lr.created_at, delivered_at: lr.delivered_at, completed_at: lr.completed_at,
          });
        }
      } catch { /* legacy table may not exist */ }
      rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const page = rows.slice(0, take);
      res.status(200).json({
        commands: page.map((r) => {
          let payload: unknown = {};
          try { payload = JSON.parse(r.payload); } catch { payload = {}; }
          const voucherCount = Array.isArray((payload as { vouchers?: unknown[] })?.vouchers)
            ? ((payload as { vouchers: unknown[] }).vouchers.length)
            : undefined;
          return {
            id: r.id, connectorId: r.connector_id, command: r.command,
            status: r.status, createdAt: r.created_at,
            deliveredAt: r.delivered_at, completedAt: r.completed_at,
            voucherCount,
          };
        }),
      });
    } catch (err) {
      console.error("[whizunik][commands/list] failed:", err);
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
    }
  });
});

/**
 * GET /commands/status/:id — single push command status (JWT auth).
 * (Path avoids colliding with /commands/pending below.)
 */
router.get("/commands/status/:id", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    try {
      const userId = req.user!.userId;
      let row = db.prepare(
        `SELECT id, connector_id, command, payload, status, created_at, delivered_at, completed_at
         FROM connector_commands WHERE id = ? AND tenant_id = ?`
      ).get(req.params.id, userId) as
        | { id: string; connector_id: string; command: string; payload: string; status: string; created_at: string; delivered_at: string | null; completed_at: string | null }
        | undefined;
      if (!row) {
        // Legacy fallback: tally_sync_commands keyed by connector row id.
        try {
          const lr = db.prepare(
            `SELECT tc.id, tcc.connector_id AS connector_id, tc.command, tc.payload, tc.status, tc.created_at, tc.delivered_at, tc.completed_at
             FROM tally_sync_commands tc JOIN tally_connectors tcc ON tcc.id = tc.connector_id
             WHERE tc.id = ? AND tc.user_id = ?`
          ).get(req.params.id, userId) as
            | { id: string; connector_id: string; command: string; payload: string; status: string; created_at: string; delivered_at: string | null; completed_at: string | null }
            | undefined;
          if (lr) row = lr;
        } catch { /* ignore */ }
      }
      if (!row) {
        sendWzError(res, "INVALID_PAYLOAD", "Command not found for this account");
        return;
      }
      let payload: unknown = {};
      try { payload = JSON.parse(row.payload); } catch { payload = {}; }
      res.status(200).json({
        id: row.id, connectorId: row.connector_id, command: row.command,
        payload, status: row.status, createdAt: row.created_at,
        deliveredAt: row.delivered_at, completedAt: row.completed_at,
      });
    } catch (err) {
      console.error("[whizunik][commands/get] failed:", err);
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
    }
  });
});

/**
 * GET /commands/pending — connector polls its queued pushes (Bearer auth).
 * Pending commands are returned FIFO and marked DELIVERED.
 */
router.get("/commands/pending", (req: Request, res: Response) => {
  wzAuthMiddleware(req, res, () => {
    try {
      const claims = (req as Request & { wzClaims?: AccessClaims }).wzClaims!;
      const rows = db.prepare(
        `SELECT id, command, payload, created_at FROM connector_commands
         WHERE connector_id = ? AND status = 'PENDING' ORDER BY created_at LIMIT 20`
      ).all(claims.connectorId) as Array<{ id: string; command: string; payload: string; created_at: string }>;
      if (rows.length > 0) {
        const ids = rows.map((r) => `'${r.id.replace(/'/g, "''")}'`).join(",");
        db.prepare(
          `UPDATE connector_commands SET status = 'DELIVERED', delivered_at = datetime('now') WHERE id IN (${ids})`
        ).run();
      }
      res.status(200).json({
        commands: rows.map((r) => {
          let payload: unknown = {};
          try {
            payload = JSON.parse(r.payload);
          } catch {
            payload = {};
          }
          return { id: r.id, command: r.command, payload, createdAt: r.created_at };
        }),
      });
    } catch (err) {
      console.error("[whizunik][commands/pending] failed:", err);
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
    }
  });
});

/** POST /commands/ack — connector acknowledges a pushed command (Bearer auth). */
router.post("/commands/ack", (req: Request, res: Response) => {
  wzAuthMiddleware(req, res, () => {
    const parsed = wzAckCommandSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
      return;
    }
    try {
      const claims = (req as Request & { wzClaims?: AccessClaims }).wzClaims!;
      const row = db.prepare(`SELECT id, connector_id, status FROM connector_commands WHERE id = ?`).get(
        parsed.data.commandId
      ) as { id: string; connector_id: string; status: string } | undefined;
      if (!row || row.connector_id !== claims.connectorId) {
        sendWzError(res, "INVALID_PAYLOAD", "Unknown command for this connector");
        return;
      }
      db.prepare(
        `UPDATE connector_commands SET status = ?, completed_at = datetime('now') WHERE id = ?`
      ).run(parsed.data.status, row.id);
      res.status(200).json({ id: row.id, status: parsed.data.status });
    } catch (err) {
      console.error("[whizunik][commands/ack] failed:", err);
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
    }
  });
});

export default router;
