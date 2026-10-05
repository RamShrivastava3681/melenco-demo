import { v4 as uuidv4 } from "uuid";
import db from "../../../db/index.js";
import { config } from "../utils/env.js";
import { generatePairingCode, sha256, safeEqual } from "../utils/crypto.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.service.js";

export interface PairingCode {
  id: string;
  code: string; // plaintext returned exactly once to the frontend
  expiresAt: string;
}

/** Generate a new pairing code for the authenticated user (hashed at rest). */
export function createPairingCode(userId: string, requestId?: string): PairingCode {
  const code = generatePairingCode();
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + config.pairingCodeTtlMinutes * 60_000).toISOString();

  db.prepare(
    `INSERT INTO tally_pairing_codes (id, user_id, code_hash, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(id, userId, sha256(code), expiresAt);

  audit("PAIRING_CODE_CREATED", { userId, requestId, detail: { expiresAt } });
  return { id, code, expiresAt };
}

/**
 * Consume a pairing code. Single-use: marks used immediately on success so a
 * concurrent reuse fails. Throws structured errors on invalid/expired/used codes.
 */
export function consumePairingCode(
  code: string,
  userId: string,
  requestId?: string
): { id: string } {
  const codeHash = sha256(code);

  const row = db
    .prepare(
      `SELECT id, user_id, expires_at, used_at, attempts FROM tally_pairing_codes WHERE code_hash = ?`
    )
    .get(codeHash) as
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
  db.prepare(`UPDATE tally_pairing_codes SET used_at = datetime('now') WHERE id = ?`).run(row.id);
  return { id: row.id };
}

/** Look up a code without consuming it (used by connect flow before full validation). */
export function peekPairingCode(code: string): { id: string; user_id: string; expires_at: string; used_at: string | null } {
  const row = db
    .prepare(
      `SELECT id, user_id, expires_at, used_at FROM tally_pairing_codes WHERE code_hash = ?`
    )
    .get(sha256(code)) as
    | { id: string; user_id: string; expires_at: string; used_at: string | null }
    | undefined;
  if (!row) throw new ApiError("AUTHENTICATION_FAILED", "Invalid pairing code");
  return row;
}

export { safeEqual };
