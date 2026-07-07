/**
 * Shared constants for the MCP OAuth module.
 *
 * The issuer is the backend's own public origin (the OAuth authorization server
 * runs on `api.mention.earth`). The consent redirect points at the frontend
 * apex SPA, which renders the approval screen and (once the user is signed in
 * with Oxy) POSTs back to `/mcp/oauth/approve`.
 */

/** JWT `aud` claim for every MCP access token — the resource server identifier. */
export const MCP_TOKEN_AUDIENCE = 'mention-mcp';

/**
 * OAuth issuer / authorization-server origin (no trailing slash). This is the
 * backend's own public API origin — the discovery document, authorize, and
 * token endpoints all live here.
 */
export const MCP_ISSUER = (
  process.env.MENTION_PUBLIC_API_URL || 'http://localhost:3000'
).replace(/\/+$/, '');

/** Frontend origin that hosts the interactive consent screen (no trailing slash). */
export const MCP_FRONTEND_ORIGIN = (
  process.env.MENTION_FRONTEND_ORIGIN || 'https://mention.earth'
).replace(/\/+$/, '');

/** Path on the frontend SPA that renders the MCP consent screen. */
export const MCP_CONSENT_PATH = '/oauth/mcp/authorize';

/** Access-token lifetime in seconds (short-lived; refreshed via refresh_token). */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = Number(
  process.env.MCP_ACCESS_TOKEN_TTL_SECONDS || 3600,
);

/** Authorization-code lifetime in seconds (single-use, short window). */
export const MCP_AUTH_CODE_TTL_SECONDS = Number(
  process.env.MCP_AUTH_CODE_TTL_SECONDS || 300,
);

/** Scopes advertised in the discovery document / accepted by the flow. */
export const MCP_SUPPORTED_SCOPES = ['mcp:read', 'mcp:write', 'offline_access'];

/** Default scopes granted when a client requests none. */
export const MCP_DEFAULT_SCOPES = ['mcp:read'];
