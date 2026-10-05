/**
 * Canonical public base URL for the WhizUnik Cloud API (TallyPrime).
 * The desktop connector (outbound HTTPS only) is always pointed here —
 * never at localhost or any other default.
 */
export const WHIZUNIK_API_BASE_URL = "https://api.whizunik.com";

export const WHIZUNIK_PROTOCOL_VERSION = "1.0";

export function publicApiBaseUrl(): string {
  const configured = (process.env.PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
  return configured || WHIZUNIK_API_BASE_URL;
}
