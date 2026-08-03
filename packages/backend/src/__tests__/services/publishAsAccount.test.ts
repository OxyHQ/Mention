import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountMember } from '@oxyhq/core';

/**
 * `assertCanPublishAsAccount` — "may this person publish as that account".
 *
 * The whole point of this suite is the DISTINCTION the gate draws between two
 * families of account, because collapsing them is the mistake that reads as
 * correct:
 *
 *  - A **channel** cannot be acted as at all, so accepted membership is the whole
 *    authority. A `viewer` of a channel may publish as it.
 *  - An **organization / project / bot** CAN be acted as, and the right that
 *    governs that is `account:act_as`. A `viewer` of an organization may NOT
 *    publish as it, even though they are just as much a member.
 *
 * Every fixture below therefore carries an EXPLICIT `permissions` array, and the
 * channel cases deliberately use a permission set WITHOUT `account:act_as` while
 * the organization cases include both shapes. A suite whose members all held
 * `account:act_as` could not tell the real check from `Boolean(membership)`; a
 * suite whose channels all held it could not tell the real check from "everything
 * needs act_as". The two mutation guards named below are the ones that fail if
 * either half is loosened.
 *
 * `resolveUserSummaries` is mocked because it is the Redis/Oxy identity path, not
 * because the kind is incidental — the kind is the first thing the gate decides
 * on.
 */

const resolveUserSummaries = vi.hoisted(() => vi.fn());

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries,
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  assertCanPublishAsAccount,
  cacheAccountMemberReads,
  isChannelAccount,
  PublishAsAccessError,
  resolveAccountKind,
  type AccountMemberReader,
} from '../../services/publishAsAccount';

const CALLER = 'caller-1';
const CHANNEL = 'channel-1';
const ORGANIZATION = 'org-1';
const PROJECT = 'project-1';
const BOT = 'bot-1';
const PERSONAL = 'personal-1';

/** The permission sets Oxy derives from its roles, as they arrive on the wire. */
const OWNER_PERMISSIONS = ['account:read', 'account:update', 'account:act_as', 'members:read'];
const EDITOR_PERMISSIONS = ['account:read', 'account:act_as', 'members:read'];
/** `viewer` — a real, active member who deliberately may NOT act as the account. */
const VIEWER_PERMISSIONS = ['account:read', 'members:read', 'children:read', 'apps:read'];
/** `developer` — another active member without `account:act_as`. */
const DEVELOPER_PERMISSIONS = ['account:read', 'children:read', 'credentials:create'];

function member(overrides: Partial<AccountMember> = {}): AccountMember {
  return {
    _id: 'member-row-1',
    accountId: 'account-1',
    memberUserId: CALLER,
    role: 'viewer',
    permissions: VIEWER_PERMISSIONS,
    inherit: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A reader that answers with a fixed list, and counts how often it was asked. */
function readerReturning(members: AccountMember[]): AccountMemberReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listAccountMembers(accountId: string) {
      calls.push(accountId);
      return members;
    },
  };
}

function kindsAre(byId: Record<string, string>): void {
  resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const map = new Map<string, { user: { id: string; kind?: string; name: object } }>();
    for (const id of ids) {
      const kind = byId[id];
      if (kind) map.set(id, { user: { id, kind, name: {} } });
    }
    return map;
  });
}

beforeEach(() => {
  resolveUserSummaries.mockReset();
  kindsAre({
    [CHANNEL]: 'channel',
    [ORGANIZATION]: 'organization',
    [PROJECT]: 'project',
    [BOT]: 'bot',
    [PERSONAL]: 'personal',
  });
});

describe('assertCanPublishAsAccount — the free path', () => {
  it('answers with the caller and no kind when no account was named', async () => {
    const reader = readerReturning([]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: null, callerId: CALLER, memberReader: reader }),
    ).resolves.toEqual({ authorId: CALLER, authorKind: null });

    // Not one question asked of Oxy — this is the overwhelming majority of posts.
    expect(reader.calls).toEqual([]);
    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });

  it('treats naming your OWN account as naming none', async () => {
    const reader = readerReturning([]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: CALLER, callerId: CALLER, memberReader: reader }),
    ).resolves.toEqual({ authorId: CALLER, authorKind: null });

    expect(reader.calls).toEqual([]);
  });

  it('trims before comparing, so whitespace does not buy a membership lookup', async () => {
    const reader = readerReturning([]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: `  ${CALLER} `, callerId: CALLER, memberReader: reader }),
    ).resolves.toEqual({ authorId: CALLER, authorKind: null });

    expect(reader.calls).toEqual([]);
  });
});

describe('assertCanPublishAsAccount — a channel', () => {
  it('admits an ACTIVE member with no account:act_as at all', async () => {
    const reader = readerReturning([member({ role: 'viewer', permissions: VIEWER_PERMISSIONS })]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
    ).resolves.toEqual({ authorId: CHANNEL, authorKind: 'channel' });

    expect(reader.calls).toEqual([CHANNEL]);
  });

  /**
   * MUTATION GUARD (the other direction). Requiring `account:act_as` for EVERY
   * kind — the obvious "simplification" of the two-family rule — locks every
   * channel viewer out of the only mechanism a channel post can be written by,
   * and the test above is the one that fails. This one states why the two halves
   * cannot be merged: a channel can never be acted as, so `account:act_as` over
   * one is a right nobody holds.
   */
  it('MUTATION GUARD: no channel membership carries account:act_as, so requiring it would refuse them all', async () => {
    const reader = readerReturning([
      member({ memberUserId: 'someone-else', role: 'owner', permissions: OWNER_PERMISSIONS }),
      member({ role: 'editor', permissions: VIEWER_PERMISSIONS }),
    ]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
    ).resolves.toEqual({ authorId: CHANNEL, authorKind: 'channel' });
  });

  it('refuses a non-member (403)', async () => {
    const reader = readerReturning([member({ memberUserId: 'somebody-else', permissions: OWNER_PERMISSIONS })]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it.each([['invited'], ['removed']] as const)('refuses a %s membership (403)', async (status) => {
    const reader = readerReturning([member({ status, permissions: OWNER_PERMISSIONS })]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('assertCanPublishAsAccount — an act-as-eligible account', () => {
  const eligible: Array<[string, string]> = [
    ['organization', ORGANIZATION],
    ['project', PROJECT],
    ['bot', BOT],
  ];

  it.each(eligible)('admits a %s member holding account:act_as', async (kind, accountId) => {
    const reader = readerReturning([member({ role: 'editor', permissions: EDITOR_PERMISSIONS })]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: accountId, callerId: CALLER, memberReader: reader }),
    ).resolves.toEqual({ authorId: accountId, authorKind: kind });
  });

  /**
   * MUTATION GUARD. This is the test that must fail if the act-as check is
   * loosened to bare membership: the fixture is an ACTIVE, genuine `viewer` — so
   * `members.some(m => m.memberUserId === callerId && m.status === 'active')` says
   * yes, and only reading `permissions` says no. It is the same person Oxy's own
   * `POST /accounts/:id/switch` refuses, so admitting them here would hand out
   * through this door exactly what that one is closed against.
   */
  it.each(eligible)(
    'MUTATION GUARD: refuses an ACTIVE %s member without account:act_as (403)',
    async (_kind, accountId) => {
      const reader = readerReturning([member({ role: 'viewer', permissions: VIEWER_PERMISSIONS })]);

      await expect(
        assertCanPublishAsAccount({ publishAsOxyUserId: accountId, callerId: CALLER, memberReader: reader }),
      ).rejects.toMatchObject({ status: 403 });
    },
  );

  it('MUTATION GUARD: refuses a developer too — it is the permission, not one role name', async () => {
    const reader = readerReturning([member({ role: 'developer', permissions: DEVELOPER_PERMISSIONS })]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: ORGANIZATION, callerId: CALLER, memberReader: reader }),
    ).rejects.toMatchObject({ status: 403 });
  });

  /**
   * The permission is read off the row Oxy resolved, never inferred from the role
   * name — so a row whose role SAYS `owner` while its permissions say otherwise is
   * refused. Without this a role→permission map would creep back in, and the copy
   * is what goes stale when Oxy changes a grant.
   */
  it('reads permissions, not the role name: role owner with no act_as permission is refused', async () => {
    const reader = readerReturning([member({ role: 'owner', permissions: VIEWER_PERMISSIONS })]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: ORGANIZATION, callerId: CALLER, memberReader: reader }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a membership whose permissions array is missing entirely', async () => {
    // A row from an older Oxy, or a truncated response. The type says the field is
    // there; the wire is not bound by the type, and an absent permission list must
    // not read as "no restrictions".
    const withoutPermissions = member({ role: 'owner' });
    Reflect.deleteProperty(withoutPermissions, 'permissions');
    const reader = readerReturning([withoutPermissions]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: ORGANIZATION, callerId: CALLER, memberReader: reader }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('matches the ACTIVE row when the caller also has an inactive one', async () => {
    const reader = readerReturning([
      member({ status: 'removed', role: 'owner', permissions: OWNER_PERMISSIONS }),
      member({ _id: 'member-row-2', status: 'active', role: 'editor', permissions: EDITOR_PERMISSIONS }),
    ]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: ORGANIZATION, callerId: CALLER, memberReader: reader }),
    ).resolves.toEqual({ authorId: ORGANIZATION, authorKind: 'organization' });
  });

  it('does NOT borrow another member\'s act_as', async () => {
    const reader = readerReturning([
      member({ memberUserId: 'somebody-else', role: 'owner', permissions: OWNER_PERMISSIONS }),
      member({ role: 'viewer', permissions: VIEWER_PERMISSIONS }),
    ]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: ORGANIZATION, callerId: CALLER, memberReader: reader }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('assertCanPublishAsAccount — the refusals that never reach Oxy', () => {
  it('refuses a personal account (400), before any membership call', async () => {
    const reader = readerReturning([member({ role: 'owner', permissions: OWNER_PERMISSIONS })]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: PERSONAL, callerId: CALLER, memberReader: reader }),
    ).rejects.toMatchObject({ status: 400 });
    expect(reader.calls).toEqual([]);
  });

  it('refuses an account whose kind will not resolve (400) — failing closed', async () => {
    const reader = readerReturning([member({ role: 'owner', permissions: OWNER_PERMISSIONS })]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: 'unknown-account', callerId: CALLER, memberReader: reader }),
    ).rejects.toMatchObject({ status: 400 });
    expect(reader.calls).toEqual([]);
  });

  it('refuses when the identity lookup itself throws (400) — failing closed', async () => {
    resolveUserSummaries.mockRejectedValue(new Error('oxy down'));
    const reader = readerReturning([member({ role: 'owner', permissions: OWNER_PERMISSIONS })]);

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: ORGANIZATION, callerId: CALLER, memberReader: reader }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses an unauthenticated caller (403)', async () => {
    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: CHANNEL,
        callerId: null,
        memberReader: readerReturning([]),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses when there is no reader to ask with (403) — an MCP caller', async () => {
    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: CHANNEL, callerId: CALLER, memberReader: undefined }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('answers 503 when the membership read fails — the caller can retry', async () => {
    const reader: AccountMemberReader = {
      listAccountMembers: async () => {
        throw new Error('oxy 500');
      },
    };

    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: ORGANIZATION, callerId: CALLER, memberReader: reader }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('the refusals are PublishAsAccessError, so the HTTP layer can map them', async () => {
    await expect(
      assertCanPublishAsAccount({ publishAsOxyUserId: PERSONAL, callerId: CALLER, memberReader: readerReturning([]) }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);
  });
});

describe('resolveAccountKind / isChannelAccount', () => {
  it('answers the kind Oxy holds', async () => {
    await expect(resolveAccountKind(ORGANIZATION)).resolves.toBe('organization');
    await expect(resolveAccountKind(CHANNEL)).resolves.toBe('channel');
  });

  it('answers null for an id with no resolvable account, and for no id at all', async () => {
    await expect(resolveAccountKind('nobody')).resolves.toBeNull();
    await expect(resolveAccountKind(undefined)).resolves.toBeNull();
  });

  it('fails soft to null when the identity path throws', async () => {
    resolveUserSummaries.mockRejectedValue(new Error('redis down'));
    await expect(resolveAccountKind(CHANNEL)).resolves.toBeNull();
  });

  /**
   * The reply gate's contract, unchanged by the widening: an ORGANIZATION is not a
   * channel, so its posts take replies like anybody else's. If this ever answered
   * `true` for a non-channel the whole fediverse-facing reply rule would move with
   * it.
   */
  it('is a channel test, not an "is a managed account" test', async () => {
    await expect(isChannelAccount(CHANNEL)).resolves.toBe(true);
    await expect(isChannelAccount(ORGANIZATION)).resolves.toBe(false);
    await expect(isChannelAccount(PROJECT)).resolves.toBe(false);
    await expect(isChannelAccount(BOT)).resolves.toBe(false);
    await expect(isChannelAccount(PERSONAL)).resolves.toBe(false);
    await expect(isChannelAccount(undefined)).resolves.toBe(false);
  });
});

describe('cacheAccountMemberReads', () => {
  it('asks once per account however many times it is asked', async () => {
    const reader = readerReturning([member({ permissions: EDITOR_PERMISSIONS })]);
    const cached = cacheAccountMemberReads(reader);

    await Promise.all([
      cached.listAccountMembers(ORGANIZATION),
      cached.listAccountMembers(ORGANIZATION),
      cached.listAccountMembers(ORGANIZATION),
    ]);
    await cached.listAccountMembers(ORGANIZATION);

    expect(reader.calls).toEqual([ORGANIZATION]);
  });

  it('keeps distinct accounts distinct', async () => {
    const reader = readerReturning([member({ permissions: EDITOR_PERMISSIONS })]);
    const cached = cacheAccountMemberReads(reader);

    await cached.listAccountMembers(ORGANIZATION);
    await cached.listAccountMembers(CHANNEL);
    await cached.listAccountMembers(ORGANIZATION);

    expect(reader.calls).toEqual([ORGANIZATION, CHANNEL]);
  });

  it('shares a FAILURE too, so a batch refuses consistently', async () => {
    let calls = 0;
    const cached = cacheAccountMemberReads({
      listAccountMembers: async () => {
        calls += 1;
        throw new Error('oxy 500');
      },
    });

    await expect(cached.listAccountMembers(ORGANIZATION)).rejects.toThrow('oxy 500');
    await expect(cached.listAccountMembers(ORGANIZATION)).rejects.toThrow('oxy 500');
    expect(calls).toBe(1);
  });

  it('drives the gate: authorizing one account twice costs one membership read', async () => {
    const reader = readerReturning([member({ permissions: EDITOR_PERMISSIONS })]);
    const cached = cacheAccountMemberReads(reader);

    await assertCanPublishAsAccount({
      publishAsOxyUserId: ORGANIZATION,
      callerId: CALLER,
      memberReader: cached,
    });
    await assertCanPublishAsAccount({
      publishAsOxyUserId: ORGANIZATION,
      callerId: CALLER,
      memberReader: cached,
    });

    expect(reader.calls).toEqual([ORGANIZATION]);
  });
});
