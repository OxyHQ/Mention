import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OxyAccessError } from '@oxy.so/core/server';
import { accountAccessGrant, accountAccessReader } from '../helpers/accountAccess';

/**
 * `assertCanPublishAsAccount` — "may this person publish as that account".
 *
 * The whole point of this suite is the DISTINCTION the gate draws between two
 * families of account, because collapsing them is the mistake that reads as
 * correct:
 *
 *  - A **channel** cannot be acted as at all, so membership is the whole
 *    authority. A `viewer` of a channel may publish as it.
 *  - An **organization / project / bot** CAN be acted as, and the right that
 *    governs that is `account:act_as`. A `viewer` of an organization may NOT
 *    publish as it, even though they are just as much a member.
 *
 * The caller's access is what `oxy.accountAccessFor` answers: Oxy's EFFECTIVE
 * access in the account, direct or INHERITED from an ancestor, or a typed
 * refusal. Every fixture below carries an EXPLICIT `permissions` array, and the
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
  isChannelAccount,
  PublishAsAccessError,
  resolveAccountKind,
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

/** A reader under which the caller holds `permissions` in every account. */
function readerGranting(
  permissions: readonly string[],
  source: 'direct' | 'inherited' = 'direct',
): ReturnType<typeof accountAccessReader> {
  return accountAccessReader((accountId) => accountAccessGrant(accountId, permissions, { source }));
}

/** A reader under which every question is answered with this refusal. */
function readerRefusing(error: OxyAccessError): ReturnType<typeof accountAccessReader> {
  return accountAccessReader(() => error);
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
    const reader = readerGranting(OWNER_PERMISSIONS);

    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: null,
        callerId: CALLER,
        accountAccess: reader,
      }),
    ).resolves.toEqual({ authorId: CALLER, authorKind: null });

    // Not one question asked of Oxy — this is the overwhelming majority of posts.
    expect(reader.calls).toEqual([]);
    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });

  it('treats naming your OWN account as naming none', async () => {
    const reader = readerGranting(OWNER_PERMISSIONS);

    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: CALLER,
        callerId: CALLER,
        accountAccess: reader,
      }),
    ).resolves.toEqual({ authorId: CALLER, authorKind: null });

    expect(reader.calls).toEqual([]);
  });

  it('trims before comparing, so whitespace does not buy an access read', async () => {
    const reader = readerGranting(OWNER_PERMISSIONS);

    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: `  ${CALLER} `,
        callerId: CALLER,
        accountAccess: reader,
      }),
    ).resolves.toEqual({ authorId: CALLER, authorKind: null });

    expect(reader.calls).toEqual([]);
  });
});

describe('assertCanPublishAsAccount — a channel', () => {
  it('admits a member with no account:act_as at all', async () => {
    const reader = readerGranting(VIEWER_PERMISSIONS);

    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: CHANNEL,
        callerId: CALLER,
        accountAccess: reader,
      }),
    ).resolves.toEqual({ authorId: CHANNEL, authorKind: 'channel' });

    expect(reader.calls).toEqual([CHANNEL]);
  });

  /**
   * The bug this gate had: it read `GET /accounts/:id/members`, which lists
   * DIRECT rows only, so a member of the organization a channel sits under — a
   * member by Oxy's own resolution — was refused. Oxy's effective access carries
   * the inherited membership, and the gate admits it.
   */
  it('admits a membership INHERITED from an ancestor account', async () => {
    const reader = readerGranting(VIEWER_PERMISSIONS, 'inherited');

    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: CHANNEL,
        callerId: CALLER,
        accountAccess: reader,
      }),
    ).resolves.toEqual({ authorId: CHANNEL, authorKind: 'channel' });
  });

  /**
   * MUTATION GUARD (the other direction). Requiring `account:act_as` for EVERY
   * kind — the obvious "simplification" of the two-family rule — locks every
   * channel viewer out of the only mechanism a channel post can be written by,
   * and the test above is the one that fails. This one states why the two halves
   * cannot be merged: a channel can never be acted as, so `account:act_as` over
   * one is a right nobody needs.
   */
  it('MUTATION GUARD: a channel member without account:act_as is still admitted', async () => {
    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: CHANNEL,
        callerId: CALLER,
        accountAccess: readerGranting(DEVELOPER_PERMISSIONS),
      }),
    ).resolves.toEqual({ authorId: CHANNEL, authorKind: 'channel' });
  });

  it('refuses access that lacks even account:read (403)', async () => {
    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: CHANNEL,
        callerId: CALLER,
        accountAccess: readerGranting(['billing:read']),
      }),
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
    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: accountId,
        callerId: CALLER,
        accountAccess: readerGranting(EDITOR_PERMISSIONS),
      }),
    ).resolves.toEqual({ authorId: accountId, authorKind: kind });
  });

  it('admits an INHERITED membership holding account:act_as', async () => {
    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: ORGANIZATION,
        callerId: CALLER,
        accountAccess: readerGranting(EDITOR_PERMISSIONS, 'inherited'),
      }),
    ).resolves.toEqual({ authorId: ORGANIZATION, authorKind: 'organization' });
  });

  /**
   * MUTATION GUARD. This is the test that must fail if the act-as check is
   * loosened to bare membership: the fixture is a genuine `viewer` — Oxy answers
   * with their access, and only reading `permissions` says no. It is the same
   * person Oxy's own `POST /accounts/:id/switch` refuses, so admitting them here
   * would hand out through this door exactly what that one is closed against.
   */
  it.each(eligible)(
    'MUTATION GUARD: refuses a %s member without account:act_as (403)',
    async (_kind, accountId) => {
      await expect(
        assertCanPublishAsAccount({
          publishAsOxyUserId: accountId,
          callerId: CALLER,
          accountAccess: readerGranting(VIEWER_PERMISSIONS),
        }),
      ).rejects.toMatchObject({ status: 403 });
    },
  );

  it('MUTATION GUARD: refuses a developer too — it is the permission, not one role name', async () => {
    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: ORGANIZATION,
        callerId: CALLER,
        accountAccess: readerGranting(DEVELOPER_PERMISSIONS),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  /**
   * The permission is read off the access Oxy resolved, never inferred from the
   * role name — so access whose role SAYS `owner` while its permissions say
   * otherwise is refused. Without this a role→permission map would creep back
   * in, and the copy is what goes stale when Oxy changes a grant.
   */
  it('reads permissions, not the role name: role owner with no act_as permission is refused', async () => {
    const reader = accountAccessReader((accountId) =>
      accountAccessGrant(accountId, VIEWER_PERMISSIONS, { role: 'owner' }),
    );

    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: ORGANIZATION,
        callerId: CALLER,
        accountAccess: reader,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('assertCanPublishAsAccount — what Oxy answers', () => {
  it.each([
    ['ACCESS_DENIED (Oxy 403/404)', 'ACCESS_DENIED', 403],
    ['ACCESS_SESSION_REQUIRED (Oxy 401)', 'ACCESS_SESSION_REQUIRED', 401],
    ['ACCESS_UNAVAILABLE (outage)', 'ACCESS_UNAVAILABLE', 503],
  ] as const)('maps %s to %s', async (_label, code, status) => {
    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: ORGANIZATION,
        callerId: CALLER,
        accountAccess: readerRefusing(new OxyAccessError(code, 'refused')),
      }),
    ).rejects.toMatchObject({ status });
  });

  it('answers 503, never a "no", when the read fails in an unexpected way', async () => {
    const reader = async () => {
      throw new Error('socket hang up');
    };

    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: ORGANIZATION,
        callerId: CALLER,
        accountAccess: reader,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('asks again after an outage: nothing negative is remembered', async () => {
    let outage = true;
    const reader = accountAccessReader((accountId) =>
      outage
        ? new OxyAccessError('ACCESS_UNAVAILABLE', 'oxy 502')
        : accountAccessGrant(accountId, EDITOR_PERMISSIONS),
    );
    const ask = () =>
      assertCanPublishAsAccount({
        publishAsOxyUserId: ORGANIZATION,
        callerId: CALLER,
        accountAccess: reader,
      });

    await expect(ask()).rejects.toMatchObject({ status: 503 });
    outage = false;
    await expect(ask()).resolves.toEqual({ authorId: ORGANIZATION, authorKind: 'organization' });
    expect(reader.calls).toEqual([ORGANIZATION, ORGANIZATION]);
  });
});

describe('assertCanPublishAsAccount — the refusals that never reach Oxy', () => {
  it('refuses a personal account (400), before any access read', async () => {
    const reader = readerGranting(OWNER_PERMISSIONS);

    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: PERSONAL,
        callerId: CALLER,
        accountAccess: reader,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(reader.calls).toEqual([]);
  });

  it('refuses an account whose kind will not resolve (400) — failing closed', async () => {
    const reader = readerGranting(OWNER_PERMISSIONS);

    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: 'unknown-account',
        callerId: CALLER,
        accountAccess: reader,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(reader.calls).toEqual([]);
  });

  it('refuses when the identity lookup itself throws (400) — failing closed', async () => {
    resolveUserSummaries.mockRejectedValue(new Error('oxy down'));

    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: ORGANIZATION,
        callerId: CALLER,
        accountAccess: readerGranting(OWNER_PERMISSIONS),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses an unauthenticated caller (403)', async () => {
    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: CHANNEL,
        callerId: null,
        accountAccess: readerGranting(OWNER_PERMISSIONS),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses when there is no person to ask about (403) — an MCP caller', async () => {
    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: CHANNEL,
        callerId: CALLER,
        accountAccess: undefined,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('the refusals are PublishAsAccessError, so the HTTP layer can map them', async () => {
    await expect(
      assertCanPublishAsAccount({
        publishAsOxyUserId: PERSONAL,
        callerId: CALLER,
        accountAccess: readerGranting([]),
      }),
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
