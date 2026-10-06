import { AuthManager } from "./auth/auth-manager.js";

/**
 * Cached token + its expiry, shared across the process.
 * Starts empty; the first call will always refresh.
 */
let cachedAccessToken: string = '';
let tokenExpiresAt: number = 0;

/**
 * Async token provider that the engine/connector will use.
 * If we already have a fresh token (younger than 60s before expiry), return it immediately.
 * Otherwise, ask the AuthManager to refresh it.
 * 
 * @param auth AuthManager instance (must have baseUrl set to the WhizUnik API base)
 * @param force If true, force a refresh even if a fresh token exists
 * @returns Promise resolving to the current valid access token string
 */
export async function getAccessToken(
  auth: AuthManager,
  force = false
): Promise<string> {
  const now = Date.now();
  const sixtySeconds = 60_000;

  // If we already have a fresh token, return it immediately.
  if (!force && cachedAccessToken && now < tokenExpiresAt - sixtySeconds) {
    return cachedAccessToken;
  }

  // Otherwise ask the AuthManager to refresh it.
  const fresh = await auth.getValidAccessToken(force);
  cachedAccessToken = fresh.accessToken;
  tokenExpiresAt = Number.parseInt(fresh.accessTokenExpiresAt ?? '0', 10) || 0;
  return cachedAccessToken;
}

/**
 * Reset the cache (useful for testing or forced re-pairing).
 */
export function resetAccessTokenCache(): void {
  cachedAccessToken = '';
  tokenExpiresAt = 0;
}

export { cachedAccessToken, tokenExpiresAt };