/**
 * The viewer's exclusion set: Oxy blocks/restrictions unioned with Mention's own
 * mutes.
 *
 * The Oxy helpers stay mocked — they are a network call to another service, and
 * this suite is not about Oxy. The MUTES are real rows, because they are the
 * half Mention owns and the half that just moved stores: nothing had written a
 * Mongo mute since mutes became a Postgres table, so a mute created after the
 * cutover was never applied and the reader kept seeing an author they had
 * explicitly silenced. The old suite mocked `models/Mute` and asserted the
 * arguments it was called with, which cannot distinguish "queried the right
 * thing" from "queried a collection nothing writes".
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  getBlockedUserIds: vi.fn(),
  getRestrictedUserIds: vi.fn(),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: mocks.getBlockedUserIds,
  getRestrictedUserIds: mocks.getRestrictedUserIds,
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { mutes } from '../../db/schema/engagement';
import { UserPrivacyManager } from '../../mtn/UserPrivacyManager';

/** Per-file account ids: `mutes` is one table shared by every parallel suite. */
const VIEWER = 'oxy-user-privacy-manager-viewer';
const OTHER_VIEWER = 'oxy-user-privacy-manager-other';
const OWNED_IDS = [VIEWER, OTHER_VIEWER];

async function seedMutes(userId: string, mutedIds: string[]): Promise<void> {
  if (mutedIds.length === 0) return;
  await getDb().insert(mutes).values(mutedIds.map((mutedId) => ({ userId, mutedId })));
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getBlockedUserIds.mockResolvedValue([]);
  mocks.getRestrictedUserIds.mockResolvedValue([]);
  await getDb().delete(mutes).where(inArray(mutes.userId, OWNED_IDS));
});

afterEach(async () => {
  await getDb().delete(mutes).where(inArray(mutes.userId, OWNED_IDS));
});

afterAll(async () => {
  await closePostgres();
});

describe('UserPrivacyManager Oxy authority', () => {
  it('combines Oxy blocks/restrictions with stored mutes and deduplicates', async () => {
    const scopedOxyClient = { request: 'client' };
    mocks.getBlockedUserIds.mockResolvedValue(['blocked', 'duplicate']);
    mocks.getRestrictedUserIds.mockResolvedValue(['restricted', 'duplicate']);
    await seedMutes(VIEWER, ['muted', 'duplicate']);
    // Another viewer's mute on the same table: the read must be scoped to the
    // viewer, which a mocked `find` could only ever assert by inspecting its own
    // arguments.
    await seedMutes(OTHER_VIEWER, ['not-mine']);

    const state = await UserPrivacyManager.loadPrivacyState(VIEWER, {
      oxyClient: scopedOxyClient as never,
      includeRestricted: true,
    });

    expect(state.blockedUserIds).toEqual(new Set(['blocked', 'duplicate']));
    expect(state.mutedUserIds).toEqual(new Set(['muted', 'duplicate']));
    expect(state.restrictedUserIds).toEqual(new Set(['restricted', 'duplicate']));
    expect(state.excludedUserIds).toEqual(
      new Set(['blocked', 'duplicate', 'muted', 'restricted']),
    );
    expect(mocks.getBlockedUserIds).toHaveBeenCalledWith(scopedOxyClient);
    expect(mocks.getRestrictedUserIds).toHaveBeenCalledWith(scopedOxyClient);
  });

  it('does not fetch restrictions for feed callers', async () => {
    const scopedOxyClient = { request: 'client' };
    mocks.getBlockedUserIds.mockResolvedValue(['blocked']);
    await seedMutes(VIEWER, ['muted']);

    const state = await UserPrivacyManager.loadPrivacyState(VIEWER, {
      oxyClient: scopedOxyClient as never,
    });

    expect(state.excludedUserIds).toEqual(new Set(['blocked', 'muted']));
    expect(mocks.getBlockedUserIds).toHaveBeenCalledWith(scopedOxyClient);
    expect(mocks.getRestrictedUserIds).not.toHaveBeenCalled();
  });

  it('preserves Oxy exclusions when the stored mute read fails', async () => {
    // The one case whose SUBJECT is the database failing, so the failure is
    // simulated at the query seam rather than with real rows — there is no value
    // of `userId` that makes a healthy Postgres reject. Everything the case
    // asserts (that Oxy's answers survive a mute-read failure) is still real.
    mocks.getBlockedUserIds.mockResolvedValue(['blocked']);
    mocks.getRestrictedUserIds.mockResolvedValue(['restricted']);
    const db = getDb();
    const selectSpy = vi.spyOn(db, 'select').mockReturnValueOnce({
      from: () => ({ where: () => Promise.reject(new Error('postgres down')) }),
    } as unknown as ReturnType<typeof db.select>);

    try {
      const state = await UserPrivacyManager.loadPrivacyState(VIEWER, {
        oxyClient: {} as never,
        includeRestricted: true,
      });

      expect(state.blockedUserIds).toEqual(new Set(['blocked']));
      expect(state.mutedUserIds).toEqual(new Set());
      expect(state.restrictedUserIds).toEqual(new Set(['restricted']));
      expect(state.excludedUserIds).toEqual(new Set(['blocked', 'restricted']));
    } finally {
      selectSpy.mockRestore();
    }
  });

  it('does not turn a rejected Oxy privacy context into an empty exclusion set', async () => {
    mocks.getBlockedUserIds.mockRejectedValue(
      new Error('delegated privacy authorization rejected'),
    );

    await expect(
      UserPrivacyManager.loadPrivacyState(VIEWER, {
        oxyClient: {} as never,
      }),
    ).rejects.toThrow('delegated privacy authorization rejected');
  });

  it('applies a mute created now, which the Mongo read could not see', async () => {
    // The regression this port fixes, stated as a case: a mute written through
    // the live path must be honoured on the next read.
    mocks.getBlockedUserIds.mockResolvedValue([]);
    await seedMutes(VIEWER, ['freshly-muted']);

    const state = await UserPrivacyManager.loadPrivacyState(VIEWER, {
      oxyClient: {} as never,
    });

    expect(state.mutedUserIds).toEqual(new Set(['freshly-muted']));
    expect(state.excludedUserIds).toContain('freshly-muted');
    // And it is genuinely gone once unmuted, so the assertion above cannot pass
    // against a reader that ignores its filter.
    await getDb().delete(mutes).where(eq(mutes.userId, VIEWER));
    const after = await UserPrivacyManager.loadPrivacyState(VIEWER, {
      oxyClient: {} as never,
    });
    expect(after.mutedUserIds).toEqual(new Set());
  });
});
