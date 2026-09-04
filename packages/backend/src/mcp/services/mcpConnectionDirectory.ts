/**
 * The account set behind a central Oxy MCP connection.
 *
 * Mention does not own any of this. Oxy decides which accounts a connector may
 * act as, records each account's own approval, and remembers which one is
 * selected; Mention presents the live access token it is serving and relays the
 * answer. That is the whole difference from the retired local bundles: the
 * account graph is not a Mention table any more.
 *
 * The two write calls go out under Mention's SERVICE credential — the MCP
 * bearer is the subject of the request, never the credential for it.
 *
 * `@oxyhq/mcp` 0.6.0 ships the same two calls as `requestOxyMcpAccountLink` /
 * `selectOxyMcpConnectionAccount` and the connection parser as
 * `mcpConnectionStateFrom`; this module is the same contract against the 0.5.x
 * the workspace resolves today, and collapses into those helpers when the
 * catalog range moves.
 */

import { z } from 'zod';
import { getServiceOxyClient } from '../../utils/oxyHelpers';

/** One member account of the caller's connection. */
export interface McpConnectionAccount {
  accountId: string;
  /** True for the account whose OAuth tokens the MCP client holds. */
  isOrigin: boolean;
  linkedAt: string;
}

export interface McpConnectionState {
  connectionId: string;
  originAccountId: string;
  activeAccountId: string;
  accounts: McpConnectionAccount[];
}

/**
 * The connection block Oxy attaches to an introspection response.
 *
 * Parsed defensively: an authority that does not report one, or reports one
 * that does not name its own selected account, degrades to the single-account
 * behaviour rather than failing every request.
 */
const connectionStateSchema = z.object({
  connection_id: z.string().trim().min(1),
  origin_account_id: z.string().trim().min(1),
  active_account_id: z.string().trim().min(1),
  accounts: z.array(z.object({
    account_id: z.string().trim().min(1),
    is_origin: z.boolean(),
    linked_at: z.string().trim().min(1),
  })).default([]),
});

const accountLinkSchema = z.object({
  link_url: z.string().url(),
  expires_in: z.number().int().positive(),
  connection_id: z.string().trim().min(1),
});

function toState(parsed: z.infer<typeof connectionStateSchema>): McpConnectionState {
  return {
    connectionId: parsed.connection_id,
    originAccountId: parsed.origin_account_id,
    activeAccountId: parsed.active_account_id,
    accounts: parsed.accounts.map((account) => ({
      accountId: account.account_id,
      isOrigin: account.is_origin,
      linkedAt: account.linked_at,
    })),
  };
}

/**
 * Read the connection state off token claims, bound to the token's own account.
 *
 * A block whose origin is not this token's account describes somebody else's
 * connection and is ignored: acting on it would mean serving an account this
 * token was never introspected for.
 */
export function connectionStateFromClaims(
  claims: unknown,
  tokenAccountId: string,
): McpConnectionState | null {
  if (typeof claims !== 'object' || claims === null) return null;
  const parsed = connectionStateSchema.safeParse(
    (claims as Record<string, unknown>).connection,
  );
  if (!parsed.success) return null;
  if (parsed.data.origin_account_id !== tokenAccountId) return null;
  if (!parsed.data.accounts.some(
    (account) => account.account_id === parsed.data.active_account_id,
  )) return null;
  return toState(parsed.data);
}

export interface McpAccountLink {
  linkUrl: string;
  expiresInSeconds: number;
  connectionId: string;
}

/**
 * Ask Oxy for the URL a person opens to add ANOTHER account to this connection.
 *
 * Mention never chooses the account and never sees a credential for it: the URL
 * is single-use, expires quickly, and is approved on `auth.oxy.so` by whoever
 * is signed in there as the account being added.
 */
export async function requestAccountLink(accessToken: string): Promise<McpAccountLink> {
  const body = await getServiceOxyClient().makeServiceRequest<unknown>(
    'POST',
    '/auth/mcp/oauth/connections/link-intent',
    { token: accessToken },
  );
  const parsed = accountLinkSchema.parse(body);
  return {
    linkUrl: parsed.link_url,
    expiresInSeconds: parsed.expires_in,
    connectionId: parsed.connection_id,
  };
}

/**
 * Point the connection at one of its member accounts.
 *
 * Oxy refuses an account that is not a live member, or whose approval no longer
 * holds, so the switch cannot outlive the consent behind it.
 */
export async function selectConnectionAccount(
  accessToken: string,
  accountId: string,
): Promise<McpConnectionState> {
  const body = await getServiceOxyClient().makeServiceRequest<unknown>(
    'POST',
    '/auth/mcp/oauth/connections/active',
    { token: accessToken, account_id: accountId },
  );
  const parsed = z.object({ connection: connectionStateSchema }).parse(body);
  return toState(parsed.connection);
}
