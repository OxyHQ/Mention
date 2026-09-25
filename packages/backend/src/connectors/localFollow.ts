/**
 * Following a LOCAL Oxy account from a request that is not a session.
 *
 * `POST /federation/follow` (the route the MCP `follow-user` tool and its
 * capability map to) reaches fediverse actors: Mention owns those edges. A
 * local account's edge is Oxy's, and only its owner may move it. The app does
 * that with its own Oxy session. An MCP request has no session, so it asks Oxy
 * to do it with the connector's live token as the owner's consent
 * (`POST /auth/mcp/oauth/connections/follow`).
 *
 * This module does two things: it decides whether a follow reference names a
 * local account, and it moves that edge through Oxy.
 */

import { isAtUri, isAtprotoHandle, isDid } from './atproto/constants';
import { OWN_DOMAINS } from './activitypub/ownDomain';
import { isAbsoluteHttpUrl } from './shared/url';
import { getServiceOxyClient } from '../utils/oxyHelpers';

const OXY_CONNECTION_FOLLOW_PATH = '/auth/mcp/oauth/connections/follow';

/** A local username: no dots, because a dotted bare name is an atproto handle. */
const LOCAL_USERNAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/;

/**
 * `username` is certainly a username (it came as `@name` or `name@our-domain`).
 * `bare` is a bare token that may be a username OR an Oxy account id; which one
 * is answered by asking Oxy, never by the token's shape.
 */
export type LocalFollowRef =
  | { kind: 'bare'; value: string }
  | { kind: 'username'; username: string };

/**
 * A reference that names an account on Oxy itself, or `null` for anything the
 * federated path owns.
 *
 * - `qatest`, `@qatest`            a local username
 * - `01a0d834-…`                   an Oxy account id (tried after the username)
 * - `qatest@mention.earth`         an acct on one of OUR domains, which is still
 *                                  a local account, never a remote actor
 *
 * A URL, a DID, an AT-URI, a dotted handle and an acct on any other host keep
 * going down the federated path unchanged.
 */
export function parseLocalFollowRef(raw: string): LocalFollowRef | null {
  const value = raw.trim();
  if (!value || isAbsoluteHttpUrl(value) || isDid(value) || isAtUri(value)) return null;

  const bare = value.replace(/^@/, '');
  const at = bare.lastIndexOf('@');
  if (at !== -1) {
    const username = bare.slice(0, at);
    const host = bare.slice(at + 1).toLowerCase();
    if (!OWN_DOMAINS.some((domain) => domain.toLowerCase() === host)) return null;
    return LOCAL_USERNAME_RE.test(username) ? { kind: 'username', username } : null;
  }
  if (isAtprotoHandle(bare) || !LOCAL_USERNAME_RE.test(bare)) return null;
  return bare === value ? { kind: 'bare', value } : { kind: 'username', username: bare };
}

export interface LocalFollowTarget {
  id: string;
  username?: string;
  federated: boolean;
}

type OxyAccount = { id?: string; username?: string; type?: string } | null | undefined;

async function lookup(read: () => Promise<OxyAccount>): Promise<LocalFollowTarget | null> {
  try {
    const user = await read();
    if (!user?.id) return null;
    return { id: user.id, username: user.username, federated: user.type === 'federated' };
  } catch {
    return null;
  }
}

/**
 * Resolve a local reference to its Oxy account, or `null` when there is none.
 * A bare token is tried as a username first, then as an account id.
 */
export async function resolveLocalFollowTarget(ref: LocalFollowRef): Promise<LocalFollowTarget | null> {
  const oxy = getServiceOxyClient();
  const username = ref.kind === 'username' ? ref.username : ref.value;
  const byUsername = await lookup(() => oxy.getProfileByUsername(username, { cache: false }));
  if (byUsername || ref.kind === 'username') return byUsername;
  return lookup(() => oxy.getUserById(ref.value));
}

export interface ConnectionFollowResult {
  changed: boolean;
}

/**
 * Move the served account's follow edge through Oxy, with the connector's live
 * token as the consent. `tool` is the catalog tool that token was approved for.
 * Oxy checks that the token holds the capabilities that tool requires, and it
 * chooses the follower itself. The answer is refused unless that follower is
 * the account this request serves.
 */
export async function followThroughConnection(input: {
  connectionToken: string;
  servedAccountId: string;
  targetUserId: string;
  action: 'follow' | 'unfollow';
}): Promise<ConnectionFollowResult> {
  const response = await getServiceOxyClient().makeServiceRequest<{
    account_id?: unknown;
    changed?: unknown;
  }>('POST', OXY_CONNECTION_FOLLOW_PATH, {
    token: input.connectionToken,
    tool: input.action === 'follow' ? 'follow-user' : 'unfollow-user',
    target_user_id: input.targetUserId,
    action: input.action,
  });
  if (response?.account_id !== input.servedAccountId) {
    throw Object.assign(
      new Error('Oxy moved the follow edge of a different account than this request serves'),
      { code: 'MCP_CONNECTION_ACCOUNT_MISMATCH' },
    );
  }
  return { changed: response.changed === true };
}
