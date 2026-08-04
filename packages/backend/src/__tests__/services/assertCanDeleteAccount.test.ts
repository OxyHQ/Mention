import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountMember } from '@oxyhq/core';

/**
 * `assertCanDeleteAccount` — "may this person END that account".
 *
 * The distinction this suite exists for is the one that reads as pedantic and is
 * not: **deleting a channel asks for strictly more than publishing as one.**
 *
 * `assertCanPublishAsAccount` grades a `channel` at bare ACTIVE MEMBERSHIP, and
 * correctly — a channel can never be acted as, so over a channel there is no
 * capability stronger than membership to ask for. Deletion is the exception,
 * because the stronger right exists and lives at Oxy: `DELETE /accounts/:id`
 * gates on `account:delete`, which oxy-api's `ROLE_PERMISSIONS` grants to `owner`
 * ALONE. `admin` and `editor` hold `account:act_as` without it.
 *
 * If Mention accepted a mere member here, an `editor` could destroy every post a
 * channel has published and then be refused the account archive by Oxy: a channel
 * with no content, an account still standing, and no undo. So the fixtures below
 * are chosen so that the strict check and every looser one DISAGREE:
 *
 *  - a channel member with `account:act_as` and no `account:delete` — the shape
 *    "membership is enough" and "act_as is enough" both get wrong;
 *  - a member with an EMPTY permission array, and one with no array at all, which
 *    a `permissions?.includes` written without the array guard would throw on;
 *  - an owner-shaped set that DOES carry `account:delete`, so the suite cannot
 *    pass by refusing everybody.
 *
 * `resolveUserSummaries` is mocked because it is the Redis/Oxy identity path. The
 * KIND still matters: the gate refuses an account whose kind Oxy cannot resolve
 * at all, and hands the resolved kind back for the caller to judge.
 */

const resolveUserSummaries = vi.hoisted(() => vi.fn());

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries,
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  assertCanDeleteAccount,
  PublishAsAccessError,
  type AccountMemberReader,
} from '../../services/publishAsAccount';

const CALLER = 'caller-1';
const CHANNEL = 'channel-1';
const ORGANIZATION = 'org-1';
const UNKNOWN = 'unknown-1';

/** The permission sets Oxy derives from its roles, as they arrive on the wire. */
const OWNER_PERMISSIONS = [
  'account:read',
  'account:update',
  'account:delete',
  'account:act_as',
  'members:read',
];
/** `admin` — everything an owner has except the one permission that matters here. */
const ADMIN_PERMISSIONS = ['account:read', 'account:update', 'account:act_as', 'members:read'];
/** `editor` — may publish as the channel, may not end it. */
const EDITOR_PERMISSIONS = ['account:read', 'account:act_as', 'members:read'];
/** `viewer` — a real, active member with neither right. */
const VIEWER_PERMISSIONS = ['account:read', 'members:read'];

function member(overrides: Partial<AccountMember> = {}): AccountMember {
  return {
    _id: 'member-row-1',
    accountId: 'account-1',
    memberUserId: CALLER,
    role: 'owner',
    permissions: OWNER_PERMISSIONS,
    inherit: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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

function readerThatFails(): AccountMemberReader {
  return {
    async listAccountMembers() {
      throw new Error('oxy is unreachable');
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

/** The status a refusal carried, or a failure if it did not refuse at all. */
async function refusalStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PublishAsAccessError) return error.status;
    throw error;
  }
  throw new Error('the gate allowed the deletion');
}

beforeEach(() => {
  resolveUserSummaries.mockReset();
  kindsAre({ [CHANNEL]: 'channel', [ORGANIZATION]: 'organization' });
});

describe('assertCanDeleteAccount — what it allows', () => {
  it('allows a member holding account:delete, and answers with the kind', async () => {
    const reader = readerReturning([member()]);

    await expect(
      assertCanDeleteAccount({ targetOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
    ).resolves.toBe('channel');

    expect(reader.calls).toEqual([CHANNEL]);
  });

  it('does not care what KIND the account is — that is the caller’s question', async () => {
    // The gate answers "may this person", never "is this a channel". Returning
    // the kind rather than judging it is what lets one route refuse a
    // non-channel with its own status while the service keeps its own guard.
    const reader = readerReturning([member({ accountId: ORGANIZATION })]);

    await expect(
      assertCanDeleteAccount({
        targetOxyUserId: ORGANIZATION,
        callerId: CALLER,
        memberReader: reader,
      }),
    ).resolves.toBe('organization');
  });

  it('trims the target before asking about it', async () => {
    const reader = readerReturning([member()]);

    await expect(
      assertCanDeleteAccount({
        targetOxyUserId: `  ${CHANNEL} `,
        callerId: CALLER,
        memberReader: reader,
      }),
    ).resolves.toBe('channel');

    expect(reader.calls).toEqual([CHANNEL]);
  });
});

describe('assertCanDeleteAccount — the permission, not the membership', () => {
  it('refuses an ADMIN of the channel', async () => {
    const reader = readerReturning([member({ role: 'admin', permissions: ADMIN_PERMISSIONS })]);

    await expect(
      refusalStatus(
        assertCanDeleteAccount({ targetOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
      ),
    ).resolves.toBe(403);
  });

  it('refuses an EDITOR of the channel, who may publish as it', async () => {
    // The fixture the whole suite turns on: publishing as this channel is
    // theirs, ending it is not, and only a check on `account:delete` tells the
    // two apart.
    const reader = readerReturning([member({ role: 'editor', permissions: EDITOR_PERMISSIONS })]);

    await expect(
      refusalStatus(
        assertCanDeleteAccount({ targetOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
      ),
    ).resolves.toBe(403);
  });

  it('refuses a VIEWER of the channel', async () => {
    const reader = readerReturning([member({ role: 'viewer', permissions: VIEWER_PERMISSIONS })]);

    await expect(
      refusalStatus(
        assertCanDeleteAccount({ targetOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
      ),
    ).resolves.toBe(403);
  });

  it('refuses an EMPTY permission array rather than reading it as unrestricted', async () => {
    const reader = readerReturning([member({ permissions: [] })]);

    await expect(
      refusalStatus(
        assertCanDeleteAccount({ targetOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
      ),
    ).resolves.toBe(403);
  });

  it('refuses a row with NO permissions array, and does not throw doing it', async () => {
    // A row that arrived without the field at all — a serializer change, an
    // older API. `permissions.includes(...)` written without the array guard
    // raises a TypeError here, which a route turns into a 500 rather than a
    // refusal, and a 500 is not a "no" anybody can act on.
    const reader = readerReturning([
      member({ permissions: undefined as unknown as string[] }),
    ]);

    await expect(
      refusalStatus(
        assertCanDeleteAccount({ targetOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
      ),
    ).resolves.toBe(403);
  });

  it('refuses a permissions value that is not an array at all', async () => {
    const reader = readerReturning([
      member({ permissions: 'account:delete' as unknown as string[] }),
    ]);

    await expect(
      refusalStatus(
        assertCanDeleteAccount({ targetOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
      ),
    ).resolves.toBe(403);
  });
});

describe('assertCanDeleteAccount — who is asking', () => {
  it('refuses an INVITED member who has not accepted', async () => {
    const reader = readerReturning([member({ status: 'invited' })]);

    await expect(
      refusalStatus(
        assertCanDeleteAccount({ targetOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
      ),
    ).resolves.toBe(403);
  });

  it('refuses a REMOVED member, whatever permissions the stale row carries', async () => {
    const reader = readerReturning([member({ status: 'removed' })]);

    await expect(
      refusalStatus(
        assertCanDeleteAccount({ targetOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
      ),
    ).resolves.toBe(403);
  });

  it('refuses somebody who is not on the member list', async () => {
    const reader = readerReturning([member({ memberUserId: 'somebody-else' })]);

    await expect(
      refusalStatus(
        assertCanDeleteAccount({ targetOxyUserId: CHANNEL, callerId: CALLER, memberReader: reader }),
      ),
    ).resolves.toBe(403);
  });

  it('refuses an anonymous caller before asking Oxy anything', async () => {
    const reader = readerReturning([member()]);

    await expect(
      refusalStatus(
        assertCanDeleteAccount({ targetOxyUserId: CHANNEL, callerId: null, memberReader: reader }),
      ),
    ).resolves.toBe(403);

    expect(reader.calls).toEqual([]);
    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });

  it('refuses when there is no client to ask Oxy with (an MCP caller)', async () => {
    await expect(
      refusalStatus(
        assertCanDeleteAccount({
          targetOxyUserId: CHANNEL,
          callerId: CALLER,
          memberReader: undefined,
        }),
      ),
    ).resolves.toBe(403);
  });

  it('refuses an ABSENT target rather than reading it as "delete yourself"', async () => {
    // The sibling gate reads an absent target as "publish as yourself" and
    // answers SUCCESS. That is the right answer to its question and a hole in
    // this one.
    const reader = readerReturning([member()]);

    await expect(
      refusalStatus(
        assertCanDeleteAccount({ targetOxyUserId: '   ', callerId: CALLER, memberReader: reader }),
      ),
    ).resolves.toBe(403);

    expect(reader.calls).toEqual([]);
  });
});

describe('assertCanDeleteAccount — it fails closed', () => {
  it('refuses an account whose kind Oxy cannot resolve, before reading members', async () => {
    const reader = readerReturning([member()]);

    await expect(
      refusalStatus(
        assertCanDeleteAccount({ targetOxyUserId: UNKNOWN, callerId: CALLER, memberReader: reader }),
      ),
    ).resolves.toBe(400);

    expect(reader.calls).toEqual([]);
  });

  it('answers 503 when the member list cannot be read, never a silent allow', async () => {
    // An Oxy outage is indistinguishable here from "you have no members:read",
    // and both must refuse. 503 because the outage is the case a client can act
    // on by trying again.
    await expect(
      refusalStatus(
        assertCanDeleteAccount({
          targetOxyUserId: CHANNEL,
          callerId: CALLER,
          memberReader: readerThatFails(),
        }),
      ),
    ).resolves.toBe(503);
  });
});
