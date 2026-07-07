/**
 * MCP OAuth clients.
 *
 * There are two sources of clients, both enforcing the SAME guarantee: a
 * redemption whose `redirect_uri` is not byte-for-byte in the client's allowlist
 * is rejected, which (together with PKCE) stops an attacker from swapping in
 * their own callback.
 *
 *  1. STATIC clients defined here — the well-known first-party callbacks
 *     published by Anthropic (Claude) and OpenAI (ChatGPT). Redirect URIs are
 *     configurable per client via env (comma-separated) so a new first-party
 *     callback can be added without a code change.
 *  2. DYNAMICALLY-registered clients (RFC 7591) persisted in Mongo as
 *     `McpRegisteredClient` — created by `POST /mcp/oauth/register`. Clients
 *     that refuse to use a pre-shared `client_id` (Claude) register themselves
 *     this way. Use {@link getMcpClientAsync} to resolve a client id against
 *     BOTH sources; the sync {@link getMcpClient} only sees static clients.
 */
import { McpRegisteredClient } from '../models/McpRegisteredClient';

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

/**
 * Look up a STATIC client by id; returns `undefined` for unknown clients. Does
 * NOT see dynamically-registered clients — use {@link getMcpClientAsync} for a
 * lookup that covers both static config and the `McpRegisteredClient` store.
 */
export function getMcpClient(clientId: string | undefined | null): McpClient | undefined {
  if (!clientId) return undefined;
  return CLIENTS[clientId];
}

/**
 * Look up a client by id across BOTH the static config AND the Mongo
 * `McpRegisteredClient` store (RFC 7591 dynamic registration). Static clients
 * take precedence. Returns `undefined` for an unknown client id.
 */
export async function getMcpClientAsync(
  clientId: string | undefined | null,
): Promise<McpClient | undefined> {
  if (!clientId) return undefined;
  const staticClient = CLIENTS[clientId];
  if (staticClient) return staticClient;

  const registered = await McpRegisteredClient.findOne({ clientId }).lean();
  if (!registered) return undefined;
  return {
    clientId: registered.clientId,
    label: registered.label,
    redirectUris: registered.redirectUris,
  };
}

/**
 * Whether `redirectUri` is an exact, registered callback for `clientId`,
 * covering both static and dynamically-registered clients. Exact match only —
 * no prefix/substring matching, no normalization.
 */
export async function isAllowedRedirectUri(
  clientId: string | undefined | null,
  redirectUri: string | undefined | null,
): Promise<boolean> {
  if (!redirectUri) return false;
  const client = await getMcpClientAsync(clientId);
  if (!client) return false;
  return client.redirectUris.includes(redirectUri);
}

/** All registered clients (used only for diagnostics/tests). */
export function listMcpClients(): McpClient[] {
  return Object.values(CLIENTS);
}
