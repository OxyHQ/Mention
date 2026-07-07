/**
 * Pre-registered MCP OAuth clients.
 *
 * Mention does NOT implement dynamic client registration (RFC 7591). The set of
 * clients allowed to run the MCP OAuth flow is fixed and defined here. Each
 * client declares an allowlist of exact redirect URIs — a redemption whose
 * `redirect_uri` is not byte-for-byte in this list is rejected, which (together
 * with PKCE) is what stops an attacker from swapping in their own callback.
 *
 * Redirect URIs are configurable per client via env (comma-separated) so a new
 * first-party callback can be added without a code change; the defaults are the
 * public callbacks published by Anthropic (Claude) and OpenAI (ChatGPT).
 */

export interface McpClient {
  clientId: string;
  label: string;
  redirectUris: string[];
}

/** Parse a comma/newline-separated env list into trimmed, non-empty entries. */
function parseUriList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  const parsed = raw
    .split(/[\s,]+/)
    .map((uri) => uri.trim())
    .filter((uri) => uri.length > 0);
  return parsed.length > 0 ? parsed : fallback;
}

const CLAUDE_DEFAULT_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

const CHATGPT_DEFAULT_REDIRECTS = [
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chat.openai.com/connector_platform_oauth_redirect',
];

const CLIENTS: Record<string, McpClient> = {
  'claude-web': {
    clientId: 'claude-web',
    label: 'Claude',
    redirectUris: parseUriList(process.env.MCP_OAUTH_REDIRECT_URIS_CLAUDE, CLAUDE_DEFAULT_REDIRECTS),
  },
  chatgpt: {
    clientId: 'chatgpt',
    label: 'ChatGPT',
    redirectUris: parseUriList(process.env.MCP_OAUTH_REDIRECT_URIS_CHATGPT, CHATGPT_DEFAULT_REDIRECTS),
  },
};

/** Look up a registered client by id; returns `undefined` for unknown clients. */
export function getMcpClient(clientId: string | undefined | null): McpClient | undefined {
  if (!clientId) return undefined;
  return CLIENTS[clientId];
}

/**
 * Whether `redirectUri` is an exact, registered callback for `clientId`.
 * Exact match only — no prefix/substring matching, no normalization.
 */
export function isAllowedRedirectUri(clientId: string | undefined | null, redirectUri: string | undefined | null): boolean {
  const client = getMcpClient(clientId);
  if (!client || !redirectUri) return false;
  return client.redirectUris.includes(redirectUri);
}

/** All registered clients (used only for diagnostics/tests). */
export function listMcpClients(): McpClient[] {
  return Object.values(CLIENTS);
}
