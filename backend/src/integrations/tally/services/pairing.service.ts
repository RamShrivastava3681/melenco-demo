import { generatePairingCode, sha256, safeEqual } from "../utils/crypto.js";
import { config } from "../utils/env.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.service.js";
import {
  createPairingRow,
  getPairingByCodeHash,
  markPairingUsed,
} from "../../../db/storesTally.js";

export interface PairingCode {
  id: string;
  code: string; // plaintext returned exactly once to the frontend
  expiresAt: string;
}

/** Generate a new pairing code for the authenticated user (hashed at rest). */
export async function createPairingCode(userId: string, requestId?: string): Promise<PairingCode> {
  const code = generatePairingCode();
  const expiresAt = new Date(Date.now() + config.pairingCodeTtlMinutes * 60_000).toISOString();

  const row = await createPairingRow(userId, sha256(code), expiresAt);

  audit("PAIRING_CODE_CREATED", { userId, requestId, detail: { expiresAt } });
  return { id: row.id as string, code, expiresAt };
}

/**
 * Consume a pairing code. Single-use: marks used immediately on success so a
 * concurrent reuse fails. Throws structured errors on invalid/expired/used codes.
 */
export async function consumePairingCode(
  code: string,
  userId: string,
  requestId?: string
): Promise<{ id: string }> {
  const codeHash = sha256(code);

  const row = await getPairingByCodeHash(codeHash) as
    | { id: string; user_id: string; expires_at: string; used_at: string | null; attempts: number }
    | undefined;

  if (!row) {
    throw new ApiError("AUTHENTICATION_FAILED", "Invalid pairing code");
  }

  if (row.user_id !== userId) {
    // The code exists but belongs to another account — do not leak that fact.
    audit("AUTHENTICATION_FAILED", { userId, requestId, detail: { reason: "pairing_code_other_tenant" } });
    throw new ApiError("AUTHENTICATION_FAILED", "Invalid pairing code");
  }

  if (row.used_at) {
    audit("AUTHENTICATION_FAILED", { userId, requestId, detail: { reason: "pairing_code_already_used" } });
    throw new ApiError("AUTHENTICATION_FAILED", "Pairing code already used");
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    audit("PAIRING_CODE_EXPIRED", { userId, requestId, detail: { pairingCodeId: row.id } });
    throw new ApiError("AUTHENTICATION_FAILED", "Pairing code expired — generate a new one");
  }

  if (row.attempts >= config.pairingMaxAttempts) {
    audit("AUTHENTICATION_FAILED", { userId, requestId, detail: { reason: "pairing_code_attempts_exceeded" } });
    throw new ApiError("AUTHENTICATION_FAILED", "Pairing code blocked after too many attempts");
  }

  // Mark used immediately (single-use)
  const full = await getPairingByCodeHash(codeHash);
  if (full) await markPairingUsed(full);
  return { id: row.id };
}

/** Look up a code without consuming it (used by connect flow before full validation). */
export async function peekPairingCode(code: string): Promise<{ id: string; user_id: string; expires_at: string; used_at: string | null }> {
  const row = await getPairingByCodeHash(sha256(code)) as
    | { id: string; user_id: string; expires_at: string; used_at: string | null }
    | undefined;
  if (!row) throw new ApiError("AUTHENTICATION_FAILED", "Invalid pairing code");
  return row;
}

export { safeEqual };
