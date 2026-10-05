import crypto from "node:crypto";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_PREFIX } from "../constants.js";

/** Generate a URL-safe random token (default 32 bytes = 256 bits). */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** SHA-256 hex hash — used for connector tokens/secrets (never store plaintext). */
export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** HMAC-SHA256 hex signature of a canonical request string. */
export function hmacSign(secret: string, canonical: string): string {
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

/** Verify HMAC signature in constant time. */
export function hmacVerify(secret: string, canonical: string, signature: string): boolean {
  const expected = hmacSign(secret, canonical);
  return safeEqual(expected, signature.toLowerCase());
}

/** Canonical string that is signed: connectorId|requestId|timestamp|METHOD|path|bodySha256 */
export function canonicalRequest(parts: {
  connectorId: string;
  requestId: string;
  timestamp: string;
  method: string;
  path: string;
  bodyHash: string;
}): string {
  return [
    parts.connectorId,
    parts.requestId,
    parts.timestamp,
    parts.method.toUpperCase(),
    parts.path,
    parts.bodyHash,
  ].join("|");
}

/** Random pairing code: WZK-84F7-291A style (ambiguous chars excluded). */
export function generatePairingCode(): string {
  const pick = (n: number) => {
    const bytes = crypto.randomBytes(n);
    let out = "";
    for (let i = 0; i < n; i++) out += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
    return out;
  };
  return `${PAIRING_CODE_PREFIX}-${pick(4)}-${pick(4)}`;
}

/** Deterministic fallback source identity when Tally provides no reliable GUID. */
export function fallbackSourceObjectId(parts: {
  voucherType?: string | null;
  voucherNumber?: string | null;
  voucherDate?: string | null;
  amount?: number | string | null;
  partyName?: string | null;
}): string {
  const norm = (v: unknown) =>
    v === null || v === undefined ? "" : String(v).trim().toUpperCase();
  const raw = [
    norm(parts.voucherType),
    norm(parts.voucherNumber),
    norm(parts.voucherDate),
    norm(parts.amount),
    norm(parts.partyName),
  ].join("|");
  return `FBA-${sha256(raw)}`;
}
