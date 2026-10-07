import { getConnectorByPublicId, updateConnectorByRowId } from "../../../db/storesTally.js";

/**
 * AuthManager handles access token management for the WhizUnik connector.
 * It knows how to talk to the cloud, rotate the refresh-token, and store
 * the new access-token.
 * Must be initialized via initAuth() from connector.routes.ts before use.
 */
export class AuthManager {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  /**
   * Get a valid access token, optionally forcing a refresh.
   * Returns { accessToken, accessTokenExpiresAt }.
   * First checks the DB for a cached valid token.
   * If not valid or force=true, refreshes via the token endpoint.
   */
  async getValidAccessToken(force = false): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
    // If not forcing a refresh, check if we have a cached valid token from the DB
    if (!force) {
      try {
        const row = await getConnectorByPublicId("connector-id") as {
          access_token: string | null;
          access_token_expires_at: string | null;
        } | undefined;

        if (row && row.access_token && row.access_token_expires_at) {
          const expiresAt = new Date(row.access_token_expires_at).getTime();
          const now = Date.now();
          // Token is still valid (more than 60s before expiry)
          if (now < expiresAt - 60_000) {
            return { accessToken: row.access_token, accessTokenExpiresAt: row.access_token_expires_at };
          }
        }
      } catch (e) {
        // DB read failure - fall through to refresh
      }
    }

    // Force refresh or no valid cached token: call the token endpoint
    try {
      // Read current connector credentials from DB to include in refresh request
      const connectorRow = await getConnectorByPublicId("connector-id") as {
        id: string;
        refresh_token_hash: string | null;
        device_id: string | null;
        connector_id: string | null;
      } | undefined;

      if (!connectorRow || !connectorRow.refresh_token_hash || !connectorRow.device_id) {
        throw new Error('Connector credentials not found for token refresh');
      }

      // POST to the WhizUnik /token endpoint to refresh the access token
      const result = await fetch(`${this.baseUrl}/api/integrations/tally/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          refreshToken: connectorRow.refresh_token_hash,
          deviceId: connectorRow.device_id,
          connectorId: connectorRow.connector_id,
        }),
      });

      if (!result.ok) {
        const errorBody: any = await result.json();
        const code = errorBody.error?.code === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'AUTHENTICATION_FAILED';
        throw new Error(`${code}: ${errorBody.error?.message || 'Token refresh failed'}`);
      }

      const data: any = await result.json();

      // Store the new tokens in the connector record
      const expiresAt = data.accessTokenExpiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await updateConnectorByRowId(connectorRow.id, {
        access_token: data.accessToken,
        access_token_expires_at: expiresAt,
        refresh_token_hash: connectorRow.refresh_token_hash,
      });

      return { accessToken: data.accessToken, accessTokenExpiresAt: data.accessTokenExpiresAt };
    } catch (err: any) {
      const code = err.code === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'AUTHENTICATION_FAILED';
      throw new Error(`${code}: ${err.message || 'Unknown error'}`);
    }
  }

  /**
   * Refresh the access token using the refresh token.
   * POST /api/integrations/tally/token with { refreshToken, deviceId, connectorId }
   */
  async refreshAccessToken(
    refreshToken: string,
    deviceId: string,
    connectorId: string,
    baseUrl?: string
  ): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
    // POST to the WhizUnik /token endpoint to refresh the access token
    const url = baseUrl || this.baseUrl;
    const result = await fetch(`${url}/api/integrations/tally/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        refreshToken,
        deviceId,
        connectorId,
      }),
    });

    if (!result.ok) {
      const errorBody: any = await result.json();
      const code = errorBody.error?.code === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'AUTHENTICATION_FAILED';
      throw new Error(`${code}: ${errorBody.error?.message || 'Token refresh failed'}`);
    }

    const data: any = await result.json();

    // Store the new tokens in the connector record
    const expiresAt = data.accessTokenExpiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const row = await getConnectorByPublicId(connectorId);
    if (row) {
      await updateConnectorByRowId(row.id as string, {
        access_token: data.accessToken,
        access_token_expires_at: expiresAt,
        refresh_token_hash: refreshToken,
      });
    }

    return { accessToken: data.accessToken, accessTokenExpiresAt: data.accessTokenExpiresAt };
  }
}
