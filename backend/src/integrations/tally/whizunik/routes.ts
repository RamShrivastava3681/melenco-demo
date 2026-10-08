import { Router, Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import crypto from "node:crypto";
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
  wzPushMastersSchema,
  wzMasterStatusQuerySchema,
  wzMasterCustomerSchema,
  wzMasterSupplierSchema,
  wzMasterSkuSchema,
  masterIdempotencyKey,
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
import {
  ensureTenant as ensureWzTenant,
  getTenant as getWzTenant,
  getWConnectorByPublicId,
  findWConnectorByDevice,
  createWConnector,
  updateWConnector,
  findWCompanyByGuid,
  findWCompanyByName,
  getWCompany,
  createWCompany,
  updateWCompany,
  latestWCompanyForTenant,
  getWSyncBatchByBatchId,
  getWSyncBatchByRequestId,
  createWSyncBatch,
  listWSyncBatches,
  getWPairing,
  createWPairing,
  markWPairingUsed,
  createWSyncRecord,
  listWSyncRecords,
  createWCommand,
  getWCommand,
  listPendingWCommands,
  listWCommands,
  updateWCommand,
  getMasterLink,
  putMasterLink,
  updateMasterLink,
  createMasterAttempt,
  listMasterAttempts,
} from "../../../db/storesWhizunik.js";
import {
  getPairingByCodeHash,
  markPairingUsed,
  getConnectorByPublicId as getLegacyConnector,
  getCompany as getLegacyCompany,
  createSyncCommand,
  getSyncCommandGlobal,
  listSyncCommandsForUser,
} from "../../../db/storesTally.js";
import {
  getUserById,
  getCustomer,
  getSupplier,
  getProduct,
  listCustomers,
  listSuppliers,
  listProducts,
  listInvoices,
} from "../../../db/storesCore.js";

const router = Router();

router.use(traceRequestId, requireHttpsIfConfigured);

function newConnectorId(): string {
  return `wz-connector-${crypto.randomBytes(4).toString("hex")}`;
}

function newCompanyId(): string {
  return `whiz-company-${crypto.randomBytes(3).toString("hex")}`;
}

async function ensureTenant(id: string, name: string): Promise<{ id: string; name: string }> {
  const existing = await ensureWzTenant(id, name);
  return { id: existing.id as string, name: (existing.name as string) || name };
}

async function tenantNameFor(tenantId: string): Promise<string> {
  const t = await getWzTenant(tenantId);
  if (t?.name) return t.name as string;
  // Bridge legacy users table (tenant == users.id in the existing app)
  try {
    const u = await getUserById(tenantId);
    if (u?.name) return (u.name as string) || "Tenant Name";
  } catch { /* users table may not exist in isolation */ }
  return "Tenant Name";
}

async function ensureCompany(tenantId: string, name: string, tallyGuid?: string | null): Promise<{ id: string; tallyGuid: string | null }> {
  const guid = tallyGuid?.trim() ? tallyGuid.trim() : null;
  if (guid) {
    const byGuid = await findWCompanyByGuid(tenantId, guid);
    if (byGuid) {
      if (name && name !== undefined && byGuid.name !== name) {
        try { await updateWCompany(byGuid, { name }); } catch { /* noop */ }
      }
      return { id: byGuid.id as string, tallyGuid: (byGuid.tally_guid as string) ?? null };
    }
  } else {
    const byName = await findWCompanyByName(tenantId, name);
    if (byName && !byName.tally_guid) return { id: byName.id as string, tallyGuid: null };
  }
  const id = newCompanyId();
  await createWCompany({ id, tally_guid: guid, tenant_id: tenantId, name });
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
async function resolveBatchCompany(tenantId: string, companyIdInput: string): Promise<{ id: string; tenant_id: string } | null> {
  const byId = await getWCompany(companyIdInput);
  if (byId && byId.tenant_id === tenantId) return { id: byId.id as string, tenant_id: byId.tenant_id as string };

  const trimmed = companyIdInput.trim();
  if (trimmed) {
    const byGuid = await findWCompanyByGuid(tenantId, trimmed);
    if (byGuid) return { id: byGuid.id as string, tenant_id: byGuid.tenant_id as string };

    const byName = await findWCompanyByName(tenantId, trimmed);
    if (byName) return { id: byName.id as string, tenant_id: byName.tenant_id as string };
  }
  return null;
}

async function updateWConnectorByPublicId(connectorId: string, attrs: Record<string, any>): Promise<void> {
  const row = await getWConnectorByPublicId(connectorId);
  if (row) await updateWConnector(row, attrs);
}

async function issuePair(connectorId: string, deviceId: string, tenantId: string) {
  const access = signAccessToken(connectorId, deviceId, tenantId);
  const refresh = signRefreshToken(connectorId, deviceId, tenantId);
  await updateWConnectorByPublicId(connectorId, { refresh_token_hash: sha256(refresh) });
  return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt, refreshToken: refresh };
}

async function connectResponse(connectorId: string, deviceId: string, tenantId: string, company: { id: string; tallyGuid: string | null }) {
  const pair = await issuePair(connectorId, deviceId, tenantId);
  return {
    connectorId,
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    accessTokenExpiresAt: pair.accessTokenExpiresAt,
    tenant: { id: tenantId, name: await tenantNameFor(tenantId) },
    companyMapping: { tallyCompanyGuid: company.tallyGuid, whizunikCompanyId: company.id },
  };
}

/** Look up a pairing code in the new table, then fall back to legacy tally_pairing_codes. */
async function lookupPairingCode(code: string): Promise<{
  kind: "whizunik" | "legacy";
  tenantId: string;
  companyName?: string | null;
  tallyGuid?: string | null;
  expiresAt: string;
  usedAt?: string | null;
} | null> {
  const wz = await getWPairing(code);
  if (wz) {
    return { kind: "whizunik", tenantId: wz.tenant_id as string, companyName: (wz.company_name as string) ?? null, tallyGuid: (wz.tally_guid as string) ?? null, expiresAt: wz.expires_at as string, usedAt: (wz.used_at as string) ?? null };
  }
  try {
    const legacy = await getPairingByCodeHash(sha256(code));
    if (legacy) {
      return { kind: "legacy", tenantId: legacy.user_id as string, expiresAt: legacy.expires_at as string, usedAt: (legacy.used_at as string) ?? null };
    }
  } catch { /* legacy table may not exist */ }
  return null;
}

async function consumePairingCode(code: string, found: { kind: "whizunik" | "legacy"; tenantId: string }): Promise<void> {
  if (found.kind === "whizunik") {
    const row = await getWPairing(code);
    if (row) await markWPairingUsed(row);
  } else {
    const row = await getPairingByCodeHash(sha256(code));
    if (row) await markPairingUsed(row);
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
    void (async () => {
      const parsed = wzConnectSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
        return;
      }
      const input = parsed.data;
      try {
        const found = await lookupPairingCode(input.pairingCode);
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

        await ensureTenant(found.tenantId, await tenantNameFor(found.tenantId));
        const company = await ensureCompany(found.tenantId, input.company.name, input.company.tallyGuid ?? found.tallyGuid ?? undefined);

        const connectorId = newConnectorId();
        await createWConnector({
          id: uuidv4(),
          connector_id: connectorId,
          device_id: input.deviceId,
          device_name: input.deviceName,
          tenant_id: found.tenantId,
          app_version: input.appVersion,
          protocol_version: input.protocolVersion,
        });

        // Re-pairing the same device must not pile up ghost devices in the
        // dashboard: older live connectors for this (tenant, device) are
        // superseded — hidden from the device list and unable to refresh.
        // (Their access tokens die at the auth check; refresh hashes cleared.)
        try {
          const stale = await findWConnectorByDevice(found.tenantId, input.deviceId, connectorId);
          if (stale) {
            await updateWConnector(stale, { status: "replaced", refresh_token_hash: null });
            try {
              const pending = await listPendingWCommands(stale.connector_id as string, 100);
              const now = new Date().toISOString();
              for (const cmd of pending) {
                await updateWCommand(cmd, { status: "CANCELLED", completed_at: now });
              }
            } catch { /* ignore per-device cleanup failures */ }
          }
        } catch { /* supersede is best-effort; the new pairing already succeeded */ }

        await consumePairingCode(input.pairingCode, found);

        try {
          const { writeAudit } = await import("../../../db/storesTally.js");
          await writeAudit({
            userId: found.tenantId,
            connectorId,
            event: "CONNECTOR_CONNECTED",
            detail: { deviceName: input.deviceName, appVersion: input.appVersion, protocol: "whizunik" },
          });
        } catch { /* audit must never break connect */ }

        res.status(200).json(await connectResponse(connectorId, input.deviceId, found.tenantId, company));
      } catch (err) {
        console.error("[whizunik][connect] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    })();
  }
);

// ===========================================================================
// 2. POST /token — refresh access token (public, per-IP rate limited)
// ===========================================================================

router.post(
  "/token",
  wzRateLimit(60 * 60_000, 120, (req) => `wz-token|${req.ip || "unknown"}`),
  (req: Request, res: Response) => {
    void (async () => {
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
        const row = await getWConnectorByPublicId(input.connectorId);
        if (!row || row.status !== "active") {
          sendWzError(res, "AUTHENTICATION_FAILED", "Connector has been revoked");
          return;
        }
        if (!row.refresh_token_hash || row.refresh_token_hash !== sha256(input.refreshToken)) {
          sendWzError(res, "AUTHENTICATION_FAILED", "Invalid refresh token");
          return;
        }

        // Company mapping: latest company for this tenant (or the one from the last batch)
        const company = await latestWCompanyForTenant(row.tenant_id as string);
        const mapping = company ?? { id: "", tally_guid: null };

        const pair = await issuePair(row.connector_id as string, (row.device_id as string) || input.deviceId, row.tenant_id as string);
        res.status(200).json({
          connectorId: row.connector_id,
          accessToken: pair.accessToken,
          refreshToken: pair.refreshToken,
          accessTokenExpiresAt: pair.accessTokenExpiresAt,
          tenant: { id: row.tenant_id, name: await tenantNameFor(row.tenant_id as string) },
          companyMapping: { tallyCompanyGuid: (mapping as any).tally_guid, whizunikCompanyId: (mapping as any).id },
        });
      } catch (err) {
        console.error("[whizunik][token] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    })();
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
    void wzAuthMiddleware(req, res, async () => {
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
        const company = await resolveBatchCompany(claims.tenantId, input.companyId);
        if (!company) {
          sendWzError(res, "INVALID_COMPANY", "Company not found for this account");
          return;
        }

        // Idempotency: batchId OR requestId seen before → replay stored ACK
        const byBatch = await getWSyncBatchByBatchId(input.batchId);
        const existing = byBatch || (await getWSyncBatchByRequestId(input.requestId));
        if (existing && (existing as any).tenant_id === claims.tenantId) {
          res.status(200).json({ acked: true, batchId: (existing as any).batch_id, duplicate: true, receivedCount: 0 });
          return;
        }

        const receivedCount = input.records.length;
        // Store the canonical company id so legacy GUID/name uploads land on
        // the same company row the platform shows (not the raw input string).
        const canonicalCompanyId = company.id;
        try {
          await createWSyncBatch({
            id: uuidv4(),
            batch_id: input.batchId,
            request_id: input.requestId,
            sync_id: input.syncId,
            tenant_id: claims.tenantId,
            connector_id: claims.connectorId,
            company_id: canonicalCompanyId,
            entity_type: input.entityType,
            received_count: receivedCount,
            duplicate: 0,
          });
        } catch (err: unknown) {
          const msg = (err as Error)?.message || "";
          if (msg.includes("UNIQUE")) {
            const dup = (await getWSyncBatchByBatchId(input.batchId)) || (await getWSyncBatchByRequestId(input.requestId));
            res.status(200).json({ acked: true, batchId: (dup as any)?.batch_id ?? input.batchId, duplicate: true, receivedCount: 0 });
            return;
          }
          throw err;
        }

        // Receive path: persist every record so the platform can show and
        // reconcile exactly what the connector pushed (per-record storage).
        for (const r of input.records) {
          await createWSyncRecord({
            id: uuidv4(),
            batch_id: input.batchId,
            tenant_id: claims.tenantId,
            company_id: canonicalCompanyId,
            entity_type: (r as any).entityType || input.entityType,
            source_object_id: (r as any).sourceObjectId ?? null,
            source_voucher_number: (r as any).sourceVoucherNumber ?? null,
            source_voucher_date: (r as any).sourceVoucherDate ?? null,
            payload: JSON.stringify(r),
          });
        }

        await updateWConnectorByPublicId(claims.connectorId, { last_sync: new Date().toISOString() });

        res.status(200).json({ acked: true, batchId: input.batchId, duplicate: false, receivedCount });
      } catch (err: unknown) {
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
    void wzAuthMiddleware(req, res, async () => {
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
        await updateWConnectorByPublicId(claims.connectorId, {
          last_heartbeat: new Date().toISOString(),
          app_version: input.appVersion,
          protocol_version: input.protocolVersion,
          tally_version: tallyVersion,
          status: "active",
        });
        if (input.status === "running" && input.currentSync) {
          await updateWConnectorByPublicId(claims.connectorId, { last_sync: new Date().toISOString() });
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
    void (async () => {
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
        const tenantName = input.tenantName || (await tenantNameFor(tenantId));
        await ensureTenant(tenantId, tenantName);

        const companyName = input.companyName || input.company || undefined;
        const tallyGuid = input.tallyGuid || input.tallyCompanyGuid || undefined;

        const ttlMinutes = input.ttlMinutes ?? 60;
        const code = generatePairingCode();
        const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
        await createWPairing({
          code,
          tenant_id: tenantId,
          company_name: companyName ?? null,
          tally_guid: tallyGuid ?? null,
          expires_at: expiresAt,
          used_at: null,
        });

        res.status(201).json({ pairingCode: code, tenantId, expiresAt });
      } catch (err) {
        console.error("[whizunik][admin/pairing-codes] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    })();
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
      mastersPush: "/api/integrations/tally/masters/push",
      mastersStatus: "/api/integrations/tally/masters/status",
      mastersAttempts: "/api/integrations/tally/masters/attempts",
    },
  });
});

// ===========================================================================
// Receive path (platform reads what connectors pushed — JWT auth)
// ===========================================================================

/** GET /sync/batches — batch history for this tenant (receive visibility). */
router.get("/sync/batches", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    void (async () => {
      try {
        const userId = req.user!.userId;
        const { companyId, entityType, limit } = req.query as Record<string, string | undefined>;
        const take = Math.min(Math.max(parseInt(limit || "25", 10) || 25, 1), 100);
        const batches = (await listWSyncBatches(userId, {
          company_id: companyId,
          entity_type: entityType,
        }, take)).map((b) => ({
          batch_id: b.batch_id,
          request_id: b.request_id,
          sync_id: b.sync_id,
          connector_id: b.connector_id,
          company_id: b.company_id,
          entity_type: b.entity_type,
          received_count: b.received_count,
          duplicate: b.duplicate,
          created_at: b.created_at,
        }));
        res.status(200).json({ batches });
      } catch (err) {
        console.error("[whizunik][sync/batches] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    })();
  });
});

/** GET /received — individual records the platform received (paginated). */
router.get("/received", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    void (async () => {
      try {
        const userId = req.user!.userId;
        const { companyId, entityType, limit, offset } = req.query as Record<string, string | undefined>;
        const take = Math.min(Math.max(parseInt(limit || "50", 10) || 50, 1), 200);
        const skip = Math.max(parseInt(offset || "0", 10) || 0, 0);
        const rows = await listWSyncRecords(userId, {
          company_id: companyId,
          entity_type: entityType,
        }, take, skip);
        const records = rows.map((r) => {
          let payload: unknown = null;
          try {
            payload = JSON.parse(r.payload as string);
          } catch {
            payload = r.payload;
          }
          return {
            id: r.id,
            batch_id: r.batch_id,
            company_id: r.company_id,
            entity_type: r.entity_type,
            source_object_id: r.source_object_id,
            source_voucher_number: r.source_voucher_number,
            source_voucher_date: r.source_voucher_date,
            payload,
            created_at: r.created_at,
          };
        });
        res.status(200).json({ records, limit: take, offset: skip });
      } catch (err) {
        console.error("[whizunik][received] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    })();
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
    void (async () => {
      const parsed = wzPushCommandSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
        return;
      }
      try {
        const userId = req.user!.userId;
        const row = await getWConnectorByPublicId(parsed.data.connectorId);
        if (!row || row.tenant_id !== userId) {
          sendWzError(res, "INVALID_COMPANY", "Connector not found for this account");
          return;
        }
        const id = `cmd_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
        const created = await createWCommand({
          id,
          tenant_id: userId,
          connector_id: row.connector_id,
          command: parsed.data.command,
          payload: JSON.stringify(parsed.data.payload ?? {}),
        });
        res.status(201).json({
          id: created.id,
          connectorId: created.connector_id,
          command: created.command,
          payload: JSON.parse(created.payload as string),
          status: created.status,
          createdAt: created.created_at,
        });
      } catch (err) {
        console.error("[whizunik][commands] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    })();
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
    void (async () => {
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
        const conn = await getWConnectorByPublicId(connectorId);
        if (conn && conn.tenant_id === userId) {
          pushTarget = { kind: "whizunik", connectorId: conn.connector_id as string };
        } else {
          try {
            const legacy = await getLegacyConnector(connectorId);
            if (legacy && legacy.user_id === userId) {
              pushTarget = { kind: "legacy", rowId: legacy.id as string, connectorId: legacy.connector_id as string };
            }
          } catch { /* legacy table may not exist */ }
        }
        if (!pushTarget) {
          sendWzError(res, "INVALID_COMPANY", "Connector not found for this account");
          return;
        }
        const company = await getWCompany(companyId) as { id: string; name: string; tally_guid: string | null } | undefined;
        if (!company) {
          // Fall back to legacy tally_companies for old connectors.
          try {
            const legacyCo = await getLegacyCompany(userId, companyId);
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
        const allInvoices = await listInvoices(userId);
        const wanted = new Set(uniqueIds);
        const rows = allInvoices.filter((i) => wanted.has(i.id as string));
        if (rows.length === 0) {
          sendWzError(res, "INVALID_PAYLOAD", "No matching invoices for this account");
          return;
        }
        const foundIds = new Set(rows.map((r) => r.id));
        const missing = uniqueIds.filter((id) => !foundIds.has(id));

        // Resolve customer names
        const nameCache = new Map<string, string>();
        async function custName(cid: string): Promise<string> {
          if (nameCache.has(cid)) return nameCache.get(cid)!;
          const c = await getCustomer(userId, cid);
          const n = ((c?.name as string) ?? "Unknown");
          nameCache.set(cid, n);
          return n;
        }

        const vouchers: Array<Record<string, unknown>> = [];
        for (const r of rows) {
          vouchers.push({
            invoiceId: r.id,
            invoiceNumber: r.invoice_number,
            partyName: await custName(r.customer_id as string),
            amount: Number(r.amount),
            balance: Number(r.balance),
            issueDate: r.issue_date,
            dueDate: r.due_date,
            tallyDate: String(r.issue_date).slice(0, 10).replace(/-/g, ""),
            voucherType: "Sales",
            narration: `WhizUnik ${r.invoice_number} due ${r.due_date}`,
          });
        }

        const id = `cmd_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
        const payload = {
          companyId,
          companyName: (company as any)?.name ?? "",
          tallyCompanyGuid: (company as any)?.tally_guid ?? null,
          vouchers,
        };
        const payloadJson = JSON.stringify(payload);
        if (pushTarget.kind === "whizunik") {
          await createWCommand({
            id,
            tenant_id: userId,
            connector_id: pushTarget.connectorId,
            command: "PUSH_VOUCHERS",
            payload: payloadJson,
          });
        } else {
          await createSyncCommand({
            id,
            user_id: userId,
            connector_id: pushTarget.rowId,
            command: "PUSH_VOUCHERS",
            payload: payloadJson,
          });
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
    })();
  });
});

/**
 * GET /commands — recent push commands for this tenant (JWT auth).
 * Used by the platform UI to show Queued → Delivered → Done/Cancelled.
 */
router.get("/commands", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    void (async () => {
      try {
        const userId = req.user!.userId;
        const { connectorId, limit } = req.query as Record<string, string | undefined>;
        const take = Math.min(Math.max(parseInt(limit || "20", 10) || 20, 1), 100);
        const rows = (await listWCommands(userId, connectorId, take)).map((r) => ({
          id: r.id as string,
          connector_id: r.connector_id as string,
          command: r.command as string,
          payload: r.payload as string,
          status: r.status as string,
          created_at: r.created_at as string,
          delivered_at: (r.delivered_at as string) ?? null,
          completed_at: (r.completed_at as string) ?? null,
        }));
        // Merge legacy tally_sync_commands so old connectors' pushes show too.
        try {
          const legacyRows = await listSyncCommandsForUser(userId);
          for (const lr of legacyRows) {
            if (connectorId) {
              const conn = await getLegacyConnector(connectorId).catch(() => undefined);
              if (!conn || lr.connector_id !== conn.id) continue;
            }
            const publicRow = await import("../../../db/storesTally.js").then((m) =>
              m.getConnectorByRowId(lr.connector_id as string)
            );
            rows.push({
              id: lr.id as string,
              connector_id: (publicRow?.connector_id as string) ?? (lr.connector_id as string),
              command: lr.command as string,
              payload: lr.payload as string,
              status: lr.status as string,
              created_at: lr.created_at as string,
              delivered_at: (lr.delivered_at as string) ?? null,
              completed_at: (lr.completed_at as string) ?? null,
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
    })();
  });
});

/**
 * GET /commands/status/:id — single push command status (JWT auth).
 * (Path avoids colliding with /commands/pending below.)
 */
router.get("/commands/status/:id", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    void (async () => {
      try {
        const userId = req.user!.userId;
        const cmdId = req.params.id as string;
        let row = await getWCommand(cmdId, userId);
        if (row && (row as any).tenant_id !== userId) row = undefined;
        if (!row) {
          // Legacy fallback: tally_sync_commands keyed by connector row id.
          const lr = await getSyncCommandGlobal(cmdId);
          if (lr && lr.user_id === userId) {
            const conn = await import("../../../db/storesTally.js").then((m) =>
              m.getConnectorByRowId(lr.connector_id as string)
            );
            row = {
              ...lr,
              connector_id: (conn?.connector_id as string) ?? lr.connector_id,
            } as any;
          }
        }
        if (!row) {
          sendWzError(res, "INVALID_PAYLOAD", "Command not found for this account");
          return;
        }
        let payload: unknown = {};
        try { payload = JSON.parse(row.payload as string); } catch { payload = {}; }
        res.status(200).json({
          id: row.id, connectorId: row.connector_id, command: row.command,
          payload, status: row.status, createdAt: row.created_at,
          deliveredAt: (row.delivered_at as string) ?? null, completedAt: (row.completed_at as string) ?? null,
        });
      } catch (err) {
        console.error("[whizunik][commands/get] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    })();
  });
});

/**
 * GET /commands/pending — connector polls its queued pushes (Bearer auth).
 * Pending commands are returned FIFO and marked DELIVERED.
 */
router.get("/commands/pending", (req: Request, res: Response) => {
  void wzAuthMiddleware(req, res, async () => {
    try {
      const claims = (req as Request & { wzClaims?: AccessClaims }).wzClaims!;
      const rows = await listPendingWCommands(claims.connectorId, 20);
      if (rows.length > 0) {
        const now = new Date().toISOString();
        for (const r of rows) {
          await updateWCommand(r, { status: "DELIVERED", delivered_at: now });
        }
        // Phase 3: delivered master pushes move QUEUED links to SENDING.
        await markDeliveredMastersSending(claims.tenantId, rows as unknown as Array<{ command: string; payload: string }>);
      }
      res.status(200).json({
        commands: rows.map((r) => {
          let payload: unknown = {};
          try {
            payload = JSON.parse(r.payload as string);
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
  void wzAuthMiddleware(req, res, async () => {
    const parsed = wzAckCommandSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
      return;
    }
    try {
      const claims = (req as Request & { wzClaims?: AccessClaims }).wzClaims!;
      const row = await getWCommand(parsed.data.commandId);
      if (!row || row.connector_id !== claims.connectorId) {
        sendWzError(res, "INVALID_PAYLOAD", "Unknown command for this connector");
        return;
      }
      await updateWCommand(row, { status: parsed.data.status, completed_at: new Date().toISOString() });
      // Phase 3: master results update the per-master link + evidence log.
      if (row.command === "PUSH_MASTERS") {
        await applyMasterAck(claims.tenantId, claims.connectorId, row as any, parsed.data.status, parsed.data.result as any);
      }
      res.status(200).json({ id: row.id, status: parsed.data.status });
    } catch (err) {
      console.error("[whizunik][commands/ack] failed:", err);
      sendWzError(res, "SERVER_ERROR", "An internal error occurred");
    }
  });
});

// ===========================================================================
// Phase 3: WhizUnik → Tally master sync (customers, suppliers, SKUs)
// One PUSH_MASTERS command per master item (spec §6: one master at a time).
// Per-master state lives in master_sync_links; every attempt is logged in
// master_sync_attempts for dashboard evidence and audit.
// ===========================================================================

type MasterKind = "customer" | "supplier" | "sku";

const MASTER_TABLE: Record<MasterKind, string> = {
  customer: "customers",
  supplier: "suppliers",
  sku: "products",
};

async function loadMasterRow(tenantId: string, kind: MasterKind, id: string): Promise<Record<string, unknown> | null> {
  try {
    if (kind === "customer") return ((await getCustomer(tenantId, id)) as Record<string, unknown> | undefined) ?? null;
    if (kind === "supplier") return ((await getSupplier(tenantId, id)) as Record<string, unknown> | undefined) ?? null;
    return ((await getProduct(tenantId, id)) as Record<string, unknown> | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Map a master DB row to the validated connector payload fields. */
function masterFieldsFor(kind: MasterKind, row: Record<string, unknown>): Record<string, unknown> {
  if (kind === "sku") {
    return {
      skuCode: row.sku_code ?? null,
      name: row.name ?? null,
      hsn: row.hsn ?? null,
      gstRate: row.gst_rate ?? null,
      unit: row.base_unit ?? null,
      category: row.group_name ?? row.category ?? null,
    };
  }
  return {
    name: row.name ?? null,
    gstin: row.gstin ?? null,
    pan: row.pan ?? null,
    address: row.address ?? null,
    state: row.state ?? null,
    pin: row.pin ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    paymentTerms: row.payment_terms ?? null,
  };
}

function validateMasterFields(kind: MasterKind, fields: Record<string, unknown>): { ok: boolean; reason?: string } {
  const schema = kind === "customer" ? wzMasterCustomerSchema : kind === "supplier" ? wzMasterSupplierSchema : wzMasterSkuSchema;
  const parsed = schema.safeParse(fields);
  if (parsed.success) return { ok: true };
  return { ok: false, reason: formatWzIssues(parsed.error) };
}

/** Upsert the QUEUED link for a master being pushed (attempts accumulate). */
async function queueMasterLink(
  tenantId: string,
  kind: MasterKind,
  whizunikId: string,
  version: number,
  idempotencyKey: string,
  requestId: string,
  approvedBy: string,
): Promise<void> {
  const existing = await getMasterLink(tenantId, kind, whizunikId);
  if (existing) {
    await putMasterLink({
      tenant_id: tenantId,
      kind,
      whizunik_id: whizunikId,
      status: "QUEUED",
      version,
      attempts: Number(existing.attempts ?? 0) + 1,
      last_error: null,
      idempotency_key: idempotencyKey,
      request_id: requestId,
      approved_by: approvedBy,
    });
  } else {
    await putMasterLink({
      tenant_id: tenantId,
      kind,
      whizunik_id: whizunikId,
      version,
      status: "QUEUED",
      attempts: 1,
      idempotency_key: idempotencyKey,
      direction: "outbound",
      request_id: requestId,
      approved_by: approvedBy,
    });
  }
}

/** Delivered PUSH_MASTERS commands move their QUEUED links to SENDING. */
async function markDeliveredMastersSending(
  tenantId: string,
  rows: Array<{ command: string; payload: string }>,
): Promise<void> {
  try {
    for (const r of rows) {
      if (r.command !== "PUSH_MASTERS") continue;
      try {
        const p = JSON.parse(r.payload) as { master?: { kind?: string; id?: string } };
        const kind = p.master?.kind;
        const id = p.master?.id;
        if ((kind === "customer" || kind === "supplier" || kind === "sku") && id) {
          const link = await getMasterLink(tenantId, kind, id);
          if (link && link.status === "QUEUED") {
            await updateMasterLink(tenantId, kind, id, { status: "SENDING" });
          }
        }
      } catch { /* skip unparseable payloads */ }
    }
  } catch { /* link tracking must never break delivery */ }
}

interface MasterAckResult {
  outcome?: "synced" | "linked" | "failed" | "needs_review";
  tallyName?: string;
  tallyMasterId?: string;
  error?: string;
  match?: Record<string, unknown>;
  fieldDiff?: Array<Record<string, unknown>>;
  requestPayload?: unknown;
  responsePayload?: unknown;
  retryCount?: number;
}

/** Apply a connector ack for a PUSH_MASTERS command to the link + evidence log. */
async function applyMasterAck(
  tenantId: string,
  connectorId: string,
  cmd: { id: string; payload: string | null; created_at: string },
  ackStatus: string,
  result: MasterAckResult | undefined,
): Promise<void> {
  try {
    if (!cmd.payload) return;
    const p = JSON.parse(cmd.payload) as {
      master?: { kind?: string; id?: string; version?: number; idempotencyKey?: string };
      companyId?: string;
    };
    const kind = p.master?.kind;
    const whizunikId = p.master?.id;
    if ((kind !== "customer" && kind !== "supplier" && kind !== "sku") || !whizunikId) return;
    const version = typeof p.master?.version === "number" ? p.master.version : 1;
    const outcome = result?.outcome ?? (ackStatus === "DONE" ? "synced" : "failed");

    let linkStatus: "SYNCED" | "FAILED" | "NEEDS_REVIEW" = "FAILED";
    if (outcome === "synced" || outcome === "linked") linkStatus = "SYNCED";
    else if (outcome === "needs_review") linkStatus = "NEEDS_REVIEW";

    const link = await getMasterLink(tenantId, kind, whizunikId);
    const attempts = Number(link?.attempts ?? 0) + (typeof result?.retryCount === "number" ? result.retryCount : 0);
    await putMasterLink({
      tenant_id: tenantId,
      kind,
      whizunik_id: whizunikId,
      tally_name: result?.tallyName ?? (link?.tally_name as string) ?? null,
      tally_master_id: result?.tallyMasterId ?? (link?.tally_master_id as string) ?? null,
      version,
      status: linkStatus,
      attempts,
      last_error: result?.error ?? (ackStatus === "CANCELLED" ? "Cancelled by connector" : null),
      idempotency_key: p.master?.idempotencyKey ?? masterIdempotencyKey(kind, whizunikId, version),
      direction: "outbound",
      request_id: cmd.id,
      approved_by: (link?.approved_by as string) ?? null,
    });

    // Evidence log (§13): one row per attempt with request/response.
    const now = new Date().toISOString();
    await createMasterAttempt({
      id: `att_${uuidv4().replace(/-/g, "").slice(0, 16)}`,
      tenant_id: tenantId,
      connector_id: connectorId,
      kind,
      whizunik_id: whizunikId,
      company_id: p.companyId ?? null,
      request_id: cmd.id,
      idempotency_key: p.master?.idempotencyKey ?? masterIdempotencyKey(kind, whizunikId, version),
      requested_at: cmd.created_at,
      responded_at: now,
      http_status: linkStatus === "SYNCED" ? 200 : 422,
      tally_status: linkStatus,
      success: linkStatus === "SYNCED" ? 1 : 0,
      error_message: result?.error ?? null,
      retry_count: typeof result?.retryCount === "number" ? result.retryCount : 0,
      request_payload: JSON.stringify({ master: p.master, companyId: p.companyId ?? null }),
      response_payload: result?.responsePayload !== undefined ? JSON.stringify(result.responsePayload) : null,
    });
  } catch (err) {
    console.error("[whizunik][masters/ack] link update failed:", err);
  }
}

/**
 * POST /masters/push — queue WhizUnik masters for Tally (JWT auth).
 * Loads each master from the tenant's own tables, validates the Phase 3
 * fields, and queues one PUSH_MASTERS command per item. Invalid items are
 * reported with reasons and never queued. Dummy/test data only.
 */
router.post("/masters/push", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    void (async () => {
      const parsed = wzPushMastersSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(parsed.error));
        return;
      }
      try {
        const userId = req.user!.userId;
        const { connectorId, companyId, items } = parsed.data;

        // Resolve connector: new-spec first, legacy tc_* as fallback.
        let targetConnectorId: string | null = null;
        const conn = await getWConnectorByPublicId(connectorId);
        if (conn && conn.tenant_id === userId && conn.status === "active") {
          targetConnectorId = conn.connector_id as string;
        } else {
          try {
            const legacy = await getLegacyConnector(connectorId);
            if (legacy && legacy.user_id === userId && legacy.status !== "REVOKED") {
              targetConnectorId = legacy.connector_id as string;
            }
          } catch { /* legacy table may not exist */ }
        }
        if (!targetConnectorId) {
          sendWzError(res, "INVALID_COMPANY", "Connector not found for this account");
          return;
        }
        const company = await resolveBatchCompany(userId, companyId);
        if (!company) {
          sendWzError(res, "INVALID_COMPANY", "Company not found for this account");
          return;
        }

        const queued: Array<{ id: string; kind: string; commandId: string; idempotencyKey: string }> = [];
        const rejected: Array<{ id: string; kind: string; reason: string }> = [];
        const seen = new Set<string>();
        for (const item of items) {
          const key = `${item.kind}:${item.id}`;
          if (seen.has(key)) {
            rejected.push({ id: item.id, kind: item.kind, reason: "Duplicate item in this request" });
            continue;
          }
          seen.add(key);
          const row = await loadMasterRow(userId, item.kind, item.id);
          if (!row) {
            rejected.push({ id: item.id, kind: item.kind, reason: "Master record not found for this account" });
            continue;
          }
          const version = typeof row.version === "number" && (row.version as number) > 0 ? (row.version as number) : 1;
          const fields = masterFieldsFor(item.kind, row);
          const check = validateMasterFields(item.kind, fields);
          if (!check.ok) {
            rejected.push({ id: item.id, kind: item.kind, reason: check.reason ?? "Invalid master fields" });
            // Record the rejection on the link so the dashboard shows FAILED with cause.
            await queueMasterLink(userId, item.kind, item.id, version, masterIdempotencyKey(item.kind, item.id, version), "rejected", userId);
            await updateMasterLink(userId, item.kind, item.id, { status: "FAILED", last_error: check.reason ?? "Invalid master fields" });
            continue;
          }
          const idempotencyKey = masterIdempotencyKey(item.kind, item.id, version);
          const cmdId = `cmd_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
          const payload = {
            companyId: company.id,
            master: { kind: item.kind, id: item.id, version, idempotencyKey, fields },
          };
          await createWCommand({
            id: cmdId,
            tenant_id: userId,
            connector_id: targetConnectorId,
            command: "PUSH_MASTERS",
            payload: JSON.stringify(payload),
          });
          await queueMasterLink(userId, item.kind, item.id, version, idempotencyKey, cmdId, userId);
          queued.push({ id: item.id, kind: item.kind, commandId: cmdId, idempotencyKey });
        }

        res.status(201).json({
          connectorId: targetConnectorId,
          queued,
          rejected,
          queuedCount: queued.length,
          rejectedCount: rejected.length,
        });
      } catch (err) {
        console.error("[whizunik][masters/push] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    })();
  });
});

/**
 * GET /masters/status — per-master sync state for this tenant (JWT auth).
 * Includes NOT_SYNCED masters (rows with no link yet) so the dashboard can
 * show every WhizUnik master with one of the six Phase 3 statuses.
 */
router.get("/masters/status", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    void (async () => {
      try {
        const userId = req.user!.userId;
        const q = wzMasterStatusQuerySchema.safeParse(req.query ?? {});
        if (!q.success) {
          sendWzError(res, "INVALID_PAYLOAD", formatWzIssues(q.error));
          return;
        }
        const { kind, status, limit } = q.data;
        const kinds: MasterKind[] = kind ? [kind] : ["customer", "supplier", "sku"];
        const out: Array<Record<string, unknown>> = [];
        for (const k of kinds) {
          let rows: Array<Record<string, unknown>>;
          try {
            if (k === "customer") rows = (await listCustomers(userId)).slice(0, 500) as Array<Record<string, unknown>>;
            else if (k === "supplier") rows = (await listSuppliers(userId)).slice(0, 500) as Array<Record<string, unknown>>;
            else rows = (await listProducts(userId, 500)) as Array<Record<string, unknown>>;
          } catch {
            continue;
          }
          for (const r of rows) {
            const link = await getMasterLink(userId, k, String(r.id));
            const st = (link?.status as string) ?? "NOT_SYNCED";
            if (status && st !== status) continue;
            out.push({
              kind: k,
              id: r.id,
              name: (k === "sku" ? ((r.sku_code ?? r.name) as string) : (r.name as string)) ?? "",
              displayName: (r.name as string) ?? "",
              version: (r.version as number) ?? 1,
              status: st,
              tallyName: (link?.tally_name as string) ?? null,
              tallyMasterId: (link?.tally_master_id as string) ?? null,
              attempts: (link?.attempts as number) ?? 0,
              lastError: (link?.last_error as string) ?? null,
              idempotencyKey: (link?.idempotency_key as string) ?? null,
              requestId: (link?.request_id as string) ?? null,
              updatedAt: (link?.updated_at as string) ?? null,
            });
            if (out.length >= limit) break;
          }
          if (out.length >= limit) break;
        }
        res.status(200).json({ masters: out.slice(0, limit) });
      } catch (err) {
        console.error("[whizunik][masters/status] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    })();
  });
});

/**
 * GET /masters/attempts — sync attempt evidence for one master (JWT auth).
 * Newest first; carries request/response payloads for the details view.
 */
router.get("/masters/attempts", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    void (async () => {
      try {
        const userId = req.user!.userId;
        const { kind, id, limit } = (req.query ?? {}) as Record<string, string | undefined>;
        if (kind !== "customer" && kind !== "supplier" && kind !== "sku") {
          sendWzError(res, "INVALID_PAYLOAD", "kind must be customer, supplier or sku");
          return;
        }
        if (!id) {
          sendWzError(res, "INVALID_PAYLOAD", "id is required");
          return;
        }
        const take = Math.min(Math.max(parseInt(limit || "20", 10) || 20, 1), 100);
        const rows = await listMasterAttempts(userId, kind, id, take);
        const attempts = rows.map((r) => {
          let requestPayload: unknown = null;
          let responsePayload: unknown = null;
          try { requestPayload = r.request_payload ? JSON.parse(r.request_payload as string) : null; } catch { requestPayload = r.request_payload; }
          try { responsePayload = r.response_payload ? JSON.parse(r.response_payload as string) : null; } catch { responsePayload = r.response_payload; }
          return { ...r, request_payload: undefined, response_payload: undefined, requestPayload, responsePayload };
        });
        res.status(200).json({ attempts });
      } catch (err) {
        console.error("[whizunik][masters/attempts] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    })();
  });
});

/**
 * POST /masters/retry — re-process a master item that was stuck in SENDING
 * or FAILED. Sets the queue row status to QUEUED so the connector's poll loop
 * will pick it up on the next cycle and re-process it through processRow().
 */
router.post("/masters/retry", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    void (async () => {
      try {
        const userId = req.user!.userId;
        const { idempotencyKey } = req.body ?? {};
        if (!idempotencyKey) {
          return sendWzError(res, "INVALID_PAYLOAD", "idempotencyKey is required");
        }
        const { getMasterQueueRow, setMasterQueueRow } = await import("../../../db/storesTally.js");
        const queueRow = await getMasterQueueRow(userId, idempotencyKey);
        if (!queueRow) {
          return sendWzError(res, "INVALID_PAYLOAD", "Master item not found for this idempotencyKey");
        }
        // Set status to QUEUED, reset lastError and attempts so the connector
        // will reprocess it from scratch on the next poll cycle.
        await setMasterQueueRow(userId, idempotencyKey, {
          status: "QUEUED",
          attempts: 0,
          lastError: null,
          tallyName: queueRow.tallyName,
          tallyMasterId: queueRow.tallyMasterId,
          matchSuggestion: null,
          fieldDiff: null,
          mappingOverride: null,
          updatedAt: new Date().toISOString(),
        });
        // Note: the connector's resumeQueue() or pollOnce() will see the QUEUED
        // status and reprocess the item. The command ack to cloud (DONE/CANCELLED)
        // will be handled when the connector finishes processing.
        res.status(200).json({ ok: true, message: "Item requeued. Connector will pick up on next poll." });
      } catch (err) {
        console.error("[whizunik][masters/retry] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    })();
  });
});

/**
 * POST /masters/confirm-link — confirm a suggested Tally match for a master item
 * that is in NEEDS_REVIEW status. Links the WhizUnik record to the suggested Tally
 * record, saves the master_sync_link, and sets the queue row to SYNCED.
 * The connector's poll loop will see SYNCED and not re-process.
 * Note: the command ack to cloud (DONE) will be handled by the connector on its next
 * poll cycle or via manual ack in the UI.
 */
router.post("/masters/confirm-link", (req: Request, res: Response) => {
  requireAuth(req, res, () => {
    void (async () => {
      try {
        const userId = req.user!.userId;
        const { idempotencyKey } = req.body ?? {};
        if (!idempotencyKey) {
          return sendWzError(res, "INVALID_PAYLOAD", "idempotencyKey is required");
        }
        const { getMasterQueueRow, setMasterQueueRow } = await import("../../../db/storesTally.js");
        const { putMasterLink } = await import("../../../db/storesWhizunik.js");
        const queueRow = await getMasterQueueRow(userId, idempotencyKey);
        if (!queueRow) {
          return sendWzError(res, "INVALID_PAYLOAD", "Master item not found for this idempotencyKey");
        }
        // Extract the suggested Tally match from the queue row's matchSuggestion field
        let matchSuggestion: { tallyName: string; tallyMasterId?: string | null; via: string } | null = null;
        try {
          const rawSuggestion = JSON.parse(queueRow.matchSuggestion as string);
          if (rawSuggestion && typeof rawSuggestion.tallyName === 'string' && rawSuggestion.tallyName.length > 0) {
            matchSuggestion = {
              tallyName: rawSuggestion.tallyName,
              tallyMasterId: typeof rawSuggestion.tallyMasterId === 'string' ? rawSuggestion.tallyMasterId : null,
              via: typeof rawSuggestion.via === 'string' ? rawSuggestion.via : 'unknown',
            };
          }
        } catch { }
        if (!matchSuggestion?.tallyName) {
          return sendWzError(res, "INVALID_PAYLOAD", "No suggested match to confirm");
        }
        // Save the master_sync_link so the dashboard shows SYNCED with the Tally name
        // The kind is embedded in the idempotencyKey (e.g., "customer:ABC-123:1")
        const kind = idempotencyKey.split(":")[0] || "customer";
        await putMasterLink({
          tenant_id: userId,
          kind: kind as "customer" | "supplier" | "sku",
          whizunik_id: queueRow.whizunikId,
          tally_name: matchSuggestion.tallyName,
          tally_master_id: matchSuggestion.tallyMasterId,
          version: 1,
          status: "SYNCED",
          attempts: queueRow.attempts,
          idempotency_key: idempotencyKey,
          direction: "outbound",
          request_id: queueRow.commandId,
          approved_by: userId,
        });
        // Update the queue row to SYNCED, clear the match suggestion
        await setMasterQueueRow(userId, idempotencyKey, {
          status: "SYNCED",
          attempts: queueRow.attempts,
          lastError: null,
          tallyName: matchSuggestion.tallyName,
          tallyMasterId: matchSuggestion.tallyMasterId,
          matchSuggestion: null,
          fieldDiff: null,
          mappingOverride: null,
          updatedAt: new Date().toISOString(),
        });
        res.status(200).json({ ok: true, message: "Master linked and queue updated" });
      } catch (err) {
        console.error("[whizunik][masters/confirm-link] failed:", err);
        sendWzError(res, "SERVER_ERROR", "An internal error occurred");
      }
    })();
  });
});

export default router;
