/**
 * Canonical public base URL for the Tally API.
 * The desktop connector (outbound HTTPS only) is always pointed here —
 * never at localhost or any other default.
 * Served from the same domain as the app: https://excel.frillchills.com/api
 */
export const WHIZUNIK_API_BASE_URL = "https://excel.frillchills.com/api";

export const WHIZUNIK_PROTOCOL_VERSION = "1.0";

export function publicApiBaseUrl(): string {
  const configured = (process.env.PUBLIC_API_BASE_URL || "").trim().replace(/\/+$/, "");
  return configured || WHIZUNIK_API_BASE_URL;
}
