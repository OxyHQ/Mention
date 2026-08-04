import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountMember, AccountNode } from '@oxyhq/core';

/**
 * WHO receives a channel's notifications — `listOperatedChannelIds` and the
 * inbox scope built on top of it.
 *
 * Two rules are load-bearing here, and each one has a wrong version that reads as
 * correct. Every fixture below exists to make the right and the wrong version
 * DISAGREE, which is the only thing that makes a green run mean anything:
 *
 *  1. **Every operator, and the set never depends on the post.** A channel's
 *     notifications go to all of its active members. The forbidden alternative is
 *     routing by `Post.writtenByOxyUserId`: the set of notifications each operator
 *     then receives is a per-post partition that ENCODES who wrote what, which on
 *     a two-operator channel is total. Nothing in this module is given a post at
 *     all, and `notificationsChannelInbox.test.ts` pins the observable end of it.
 *     Guarded here by a channel with TWO operators — a suite where every channel
 *     has one operator cannot tell "all of them" from "the first one".
 *
 *  2. **Channels only.** An organization / project / bot CAN be acted as, and that
 *     switch is gated on `account:act_as` — which a `viewer` or `billing` member
 *     does not hold. Expanding those kinds into a member's personal inbox would
 *     hand out exactly the view the switch refuses. The fixture that makes this
 *     testable is an organization whose membership DOES carry `account:act_as`:
 *     it is the one shape where "filter to channel" and "any account I may act
 *     for" answer differently. Without it, deleting the kind filter passes.
 *
 * The membership shapes are chosen the same way. A channel membership deliberately
 * WITHOUT `account:act_as` distinguishes the real predicate from "everything needs
 * act_as"; an `invited` membership (a truthy, non-`active` status) distinguishes
 * `status === 'active'` from `Boolean(status)`.
 */

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSetEx: vi.fn(),
  isReady: true,
}));

vi.mock('../../utils/redis', () => ({
  getRedisClient: () => ({
    get isReady() {
      return mocks.isReady;
    },
    get: mocks.redisGet,
    setEx: mocks.redisSetEx,
  }),
}));

// `resolveUserSummaries` is the Redis/Oxy identity path pulled in transitively by
// `publishAsAccount`; nothing in this suite resolves an account kind through it
// (the kind arrives on the `AccountNode`).
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  listOperatedChannelIds,
  membershipAuthorizesActingFor,
  type OperatedAccountReader,
} from '../../services/publishAsAccount';
import { resolveNotificationInboxIds } from '../../services/notificationInbox';

const VIEWER = 'viewer-1';
const OTHER_OPERATOR = 'operator-2';

const CHANNEL_ONE = 'channel-one';
const CHANNEL_TWO = 'channel-two';
const CHANNEL_INVITED = 'channel-invited';
const CHANNEL_REMOVED = 'channel-removed';
const CHANNEL_UNMEMBERED = 'channel-unmembered';
const ORGANIZATION = 'org-1';

/** The permission sets Oxy derives from its roles, as they arrive on the wire. */
const OWNER_PERMISSIONS = ['account:read', 'account:update', 'account:act_as', 'members:read'];
/** `viewer` — a real, active member who deliberately may NOT act as the account. */
const VIEWER_PERMISSIONS = ['account:read', 'members:read', 'children:read'];

function membership(overrides: Partial<AccountMember> = {}): AccountMember {
  return {
    _id: 'member-row',
    accountId: 'account-1',
    memberUserId: VIEWER,
    role: 'viewer',
    permissions: VIEWER_PERMISSIONS,
    inherit: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function node(
  accountId: string,
  kind: AccountNode['kind'],
  callerMembership: AccountMember | null,
): AccountNode {
  return {
    accountId,
    kind,
    parentAccountId: null,
    // The Oxy user behind the account. Only `accountId`/`kind`/`callerMembership`
    // are read here; the DTO is filled in enough to be a real node.
    account: { id: accountId, username: accountId, name: { displayName: accountId } } as AccountNode['account'],
    relationship: callerMembership ? 'member' : 'self',
    callerMembership,
  };
}

/**
 * The forest as Oxy answers it for VIEWER. Every entry is a distinct reason to be
 * included or excluded — see the suite docstring; `fixtureShape` below asserts the
 * composition so a future edit cannot quietly make this vacuous.
 */
function forest(): AccountNode[] {
  return [
    // The viewer's own personal account: no membership row, ownership implicit.
    node(VIEWER, 'personal', null),
    // INCLUDED — active member, and pointedly WITHOUT `account:act_as`.
    node(CHANNEL_ONE, 'channel', membership({ accountId: CHANNEL_ONE })),
    // INCLUDED — a SECOND channel, so "all of them" ≠ "the first one".
    node(CHANNEL_TWO, 'channel', membership({ accountId: CHANNEL_TWO, role: 'owner', permissions: OWNER_PERMISSIONS })),
    // EXCLUDED — an act-as-eligible kind whose membership DOES carry act_as.
    node(ORGANIZATION, 'organization', membership({ accountId: ORGANIZATION, role: 'owner', permissions: OWNER_PERMISSIONS })),
    // EXCLUDED — a channel whose membership was never accepted.
    node(CHANNEL_INVITED, 'channel', membership({ accountId: CHANNEL_INVITED, status: 'invited' })),
    // EXCLUDED — a channel this person was removed from.
    node(CHANNEL_REMOVED, 'channel', membership({ accountId: CHANNEL_REMOVED, status: 'removed' })),
    // EXCLUDED — a channel with no membership row at all.
    node(CHANNEL_UNMEMBERED, 'channel', null),
  ];
}

function readerReturning(accounts: AccountNode[]): OperatedAccountReader & { calls: number } {
  const reader = {
    calls: 0,
    async listAccounts() {
      reader.calls += 1;
      return accounts;
    },
  };
  return reader;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isReady = true;
  mocks.redisGet.mockResolvedValue(null);
  mocks.redisSetEx.mockResolvedValue('OK');
});

describe('fixture shape (vacuity floor)', () => {
  it('exercises every distinction the rules draw', () => {
    const accounts = forest();
    const channels = accounts.filter((a) => a.kind === 'channel');
    const activeChannels = channels.filter((a) => a.callerMembership?.status === 'active');

    // Rule 1 needs more than one channel to be distinguishable from "the first".
    expect(activeChannels.length).toBeGreaterThanOrEqual(2);
    // Rule 2 needs an act-as-eligible account the caller genuinely may act for —
    // the only shape where the kind filter changes the answer.
    expect(
      accounts.some(
        (a) =>
          a.kind !== 'channel' &&
          a.callerMembership?.status === 'active' &&
          a.callerMembership.permissions.includes('account:act_as'),
      ),
    ).toBe(true);
    // A channel membership WITHOUT act_as, or the channel branch reads as
    // "everything needs act_as" and still passes.
    expect(
      activeChannels.some((a) => !a.callerMembership?.permissions.includes('account:act_as')),
    ).toBe(true);
    // A truthy, non-`active` status, or `=== 'active'` and `Boolean(status)` agree.
    expect(channels.some((a) => a.callerMembership?.status === 'invited')).toBe(true);
  });
});

describe('membershipAuthorizesActingFor', () => {
  it('accepts any ACTIVE member of a channel, with or without act_as', () => {
    expect(membershipAuthorizesActingFor('channel', membership())).toBe(true);
    expect(
      membershipAuthorizesActingFor('channel', membership({ permissions: OWNER_PERMISSIONS })),
    ).toBe(true);
  });

  it('demands act_as for an account that CAN be acted as', () => {
    expect(membershipAuthorizesActingFor('organization', membership())).toBe(false);
    expect(
      membershipAuthorizesActingFor('organization', membership({ permissions: OWNER_PERMISSIONS })),
    ).toBe(true);
    expect(membershipAuthorizesActingFor('bot', membership({ permissions: OWNER_PERMISSIONS }))).toBe(true);
  });

  it('refuses a membership that is not active, whatever the kind', () => {
    expect(membershipAuthorizesActingFor('channel', membership({ status: 'invited' }))).toBe(false);
    expect(membershipAuthorizesActingFor('channel', membership({ status: 'removed' }))).toBe(false);
    expect(
      membershipAuthorizesActingFor('organization', membership({ status: 'invited', permissions: OWNER_PERMISSIONS })),
    ).toBe(false);
  });

  it('refuses a missing membership and a kind neither family covers', () => {
    expect(membershipAuthorizesActingFor('channel', null)).toBe(false);
    expect(membershipAuthorizesActingFor('channel', undefined)).toBe(false);
    expect(membershipAuthorizesActingFor('personal', membership({ permissions: OWNER_PERMISSIONS }))).toBe(false);
    expect(membershipAuthorizesActingFor(null, membership({ permissions: OWNER_PERMISSIONS }))).toBe(false);
  });
});

describe('listOperatedChannelIds', () => {
  it('returns EVERY channel the caller actively operates, and nothing else', async () => {
    const ids = await listOperatedChannelIds(readerReturning(forest()));

    // As a set AND by length: an implementation that returns only the first, or
    // that also returns the organization, fails on one of the two.
    expect([...ids].sort()).toEqual([CHANNEL_ONE, CHANNEL_TWO].sort());
    expect(ids).toHaveLength(2);
  });

  it('excludes an organization the caller may act as', async () => {
    const ids = await listOperatedChannelIds(readerReturning(forest()));
    expect(ids).not.toContain(ORGANIZATION);
  });

  it('excludes invited, removed and unmembered channels', async () => {
    const ids = await listOperatedChannelIds(readerReturning(forest()));
    expect(ids).not.toContain(CHANNEL_INVITED);
    expect(ids).not.toContain(CHANNEL_REMOVED);
    expect(ids).not.toContain(CHANNEL_UNMEMBERED);
  });

  it("never returns the caller's own personal account", async () => {
    const ids = await listOperatedChannelIds(readerReturning(forest()));
    expect(ids).not.toContain(VIEWER);
  });

  it('gives the SAME answer to a second operator of the same channel', async () => {
    // Rule 1, from the other side: the set is a property of the channel, so two
    // people who both operate it resolve it identically. Nothing distinguishes
    // them — no post, no writer, no order.
    const forOther = [
      node(OTHER_OPERATOR, 'personal', null),
      node(CHANNEL_ONE, 'channel', membership({ accountId: CHANNEL_ONE, memberUserId: OTHER_OPERATOR })),
      node(CHANNEL_TWO, 'channel', membership({ accountId: CHANNEL_TWO, memberUserId: OTHER_OPERATOR })),
    ];

    const mine = await listOperatedChannelIds(readerReturning(forest()));
    const theirs = await listOperatedChannelIds(readerReturning(forOther));

    expect([...theirs].sort()).toEqual([...mine].sort());
  });

  it('fails soft to nothing when there is no reader (a service-credential caller)', async () => {
    await expect(listOperatedChannelIds(undefined)).resolves.toEqual([]);
  });

  it('fails soft to nothing when Oxy cannot answer', async () => {
    const reader: OperatedAccountReader = {
      async listAccounts() {
        throw new Error('oxy unavailable');
      },
    };
    // Never throws: this sits under every notification read, and the direction
    // that matters is that an outage can only ever REMOVE access.
    await expect(listOperatedChannelIds(reader)).resolves.toEqual([]);
  });
});

describe('resolveNotificationInboxIds', () => {
  it('always leads with the viewer, then the channels they operate', async () => {
    const ids = await resolveNotificationInboxIds(VIEWER, readerReturning(forest()));

    expect(ids[0]).toBe(VIEWER);
    expect([...ids].sort()).toEqual([VIEWER, CHANNEL_ONE, CHANNEL_TWO].sort());
  });

  it("still returns the viewer's own inbox when Oxy is unavailable", async () => {
    const reader: OperatedAccountReader = {
      async listAccounts() {
        throw new Error('oxy unavailable');
      },
    };
    await expect(resolveNotificationInboxIds(VIEWER, reader)).resolves.toEqual([VIEWER]);
  });

  it("still returns the viewer's own inbox when Redis is down", async () => {
    mocks.isReady = false;
    await expect(resolveNotificationInboxIds(VIEWER, undefined)).resolves.toEqual([VIEWER]);
  });

  it('serves a warm cache without asking Oxy again', async () => {
    mocks.redisGet.mockResolvedValue(JSON.stringify([CHANNEL_ONE, CHANNEL_TWO]));
    const reader = readerReturning(forest());

    const ids = await resolveNotificationInboxIds(VIEWER, reader);

    expect([...ids].sort()).toEqual([VIEWER, CHANNEL_ONE, CHANNEL_TWO].sort());
    expect(reader.calls).toBe(0);
  });

  it('writes the resolved set back with the configured TTL', async () => {
    await resolveNotificationInboxIds(VIEWER, readerReturning(forest()));

    expect(mocks.redisSetEx).toHaveBeenCalledWith(
      `notifinbox:v1:${VIEWER}`,
      expect.any(Number),
      JSON.stringify([CHANNEL_ONE, CHANNEL_TWO]),
    );
  });

  it('re-resolves rather than trusting a corrupt cache entry', async () => {
    mocks.redisGet.mockResolvedValue('{not json');
    const reader = readerReturning(forest());

    const ids = await resolveNotificationInboxIds(VIEWER, reader);

    expect(reader.calls).toBe(1);
    expect([...ids].sort()).toEqual([VIEWER, CHANNEL_ONE, CHANNEL_TWO].sort());
  });

  it('re-resolves rather than trusting a cache entry of the wrong shape', async () => {
    // A stale entry from a different value schema must not become a recipient id.
    mocks.redisGet.mockResolvedValue(JSON.stringify([{ accountId: CHANNEL_ONE }]));
    const reader = readerReturning(forest());

    const ids = await resolveNotificationInboxIds(VIEWER, reader);

    expect(reader.calls).toBe(1);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
  });
});
