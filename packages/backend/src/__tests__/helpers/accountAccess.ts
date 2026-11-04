/**
 * Fakes of the caller's Oxy account access (`oxy.accountAccessFor`, bound to a
 * request by `callerAccountAccess` in `utils/oxyHelpers`) for the gates in
 * `services/publishAsAccount`.
 *
 * Built from the SAME member rows the tests already describe an account with,
 * and answering the way the SDK does: the caller's row → their effective
 * permissions; no row → `ACCESS_DENIED` (Oxy's 403); a roster that cannot be
 * read → `ACCESS_UNAVAILABLE` (Oxy could not answer, 503).
 */
import type { AccountMember } from '@oxy.so/core';
import { OxyAccessError, type OxyAccountAccess } from '@oxy.so/core/server';
import type { AccountAccessReader } from '../../services/publishAsAccount';

/** One account's effective access, as `accountAccessFor` answers it. */
export function accountAccessGrant(
  accountId: string,
  permissions: readonly string[],
  overrides: Partial<Pick<OxyAccountAccess, 'kind' | 'relationship' | 'role' | 'source'>> = {},
): OxyAccountAccess {
  const held = new Set(permissions);
  return {
    accountId,
    kind: overrides.kind ?? 'organization',
    relationship: overrides.relationship ?? 'member',
    role: overrides.role ?? 'editor',
    source: overrides.source ?? 'direct',
    permissions: [...held].sort(),
    has: (permission) => held.has(permission),
  };
}

/** A reader that answers every account with the given access (or refusal). */
export function accountAccessReader(
  answer: (accountId: string) => OxyAccountAccess | OxyAccessError,
): AccountAccessReader & { calls: string[] } {
  const calls: string[] = [];
  const reader = async (accountId: string) => {
    calls.push(accountId);
    const result = answer(accountId);
    if (result instanceof OxyAccessError) throw result;
    return result;
  };
  return Object.assign(reader, { calls });
}

/**
 * A reader over a member-roster fake: the caller's ACTIVE row is their access;
 * no such row is Oxy's refusal; a roster read that throws is an outage. Every
 * Oxy role carries `account:read`, so the access always does too.
 */
export function accountAccessFromMembers(
  listMembers: (accountId: string) => Promise<AccountMember[]> | AccountMember[],
  callerId: string | null | undefined,
): AccountAccessReader {
  return async (accountId) => {
    let members: AccountMember[];
    try {
      members = await listMembers(accountId);
    } catch (cause) {
      throw new OxyAccessError('ACCESS_UNAVAILABLE', 'roster unavailable', { cause });
    }
    const row = members.find(
      (member) => member.memberUserId === callerId && member.status === 'active',
    );
    if (!row) throw new OxyAccessError('ACCESS_DENIED', 'not a member');
    const permissions = Array.isArray(row.permissions) ? row.permissions : [];
    return accountAccessGrant(accountId, ['account:read', ...permissions], { role: row.role });
  };
}

/** The roster part of a fake caller client (`{ accounts: { members: { list } } }`). */
interface RosterClient {
  accounts?: { members?: { list?(accountId: string): Promise<AccountMember[]> | AccountMember[] } };
}

/**
 * The `callerOxyUser` / `callerAccountAccess` pair of a `utils/oxyHelpers` mock,
 * from ONE fake caller client: the client itself is the person's user client,
 * and their account access is read off its member roster
 * ({@link accountAccessFromMembers}), so a test describes an account once.
 */
export function rosterMocks<Req extends { user?: { id?: string } | null }>(
  makeClient: (req: Req) => unknown,
) {
  return {
    callerOxyUser: makeClient,
    callerAccountAccess: (req: Req): AccountAccessReader | undefined => {
      const client = makeClient(req) as RosterClient | undefined;
      const list = client?.accounts?.members?.list;
      if (!list) return undefined;
      return accountAccessFromMembers((accountId) => list(accountId), req.user?.id);
    },
  };
}

/**
 * {@link accountAccessFromMembers} over a fake caller client, for a test that
 * hands a gate the client it built; `undefined` stays `undefined` (no person).
 */
export function rosterAccess(
  client: RosterClient | undefined,
  callerId: string | null | undefined,
): AccountAccessReader | undefined {
  if (!client) return undefined;
  return accountAccessFromMembers(async (accountId) => {
    const list = client.accounts?.members?.list;
    if (!list) throw new Error('this fake client has no member roster');
    return list(accountId);
  }, callerId);
}
