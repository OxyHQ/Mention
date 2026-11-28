import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The background reads of Bluesky accounts, against real `federated_actors` /
 * `federated_follows` rows (this file has its own database: the jobs sweep the
 * whole table). The AppView is not reached: the profile read and
 * `importAuthorFeed` are the import path, mocked at that seam.
 *
 *  - the followed sync reads only followed accounts that are due, the
 *    longest-waiting first, and stamps each one so the next tick skips it;
 *  - the history backfill pages an account's author feed from a persisted
 *    cursor, a bounded number of pages per run, and finishes at the end.
 */

const mocks = vi.hoisted(() => ({
  importAuthorFeed: vi.fn(),
  fetchAndUpsertAtprotoProfile: vi.fn(),
}));
vi.mock('../../../connectors/atproto/post.mapper', () => ({
  importAuthorFeed: mocks.importAuthorFeed,
}));
vi.mock('../../../connectors/atproto/profile.mapper', () => ({
  fetchAndUpsertAtprotoProfile: mocks.fetchAndUpsertAtprotoProfile,
}));

import {
  HISTORY_PAGES_PER_RUN,
  advanceAtprotoHistoryBackfills,
  syncFollowedAtprotoAccounts,
} from '../../../connectors/atproto/accountSync';
import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  readActor,
  seedActor,
  seedFollow,
} from '../../helpers/federationFixtures';

const scope = federationScope('atproto-account-sync');
const MINUTE = 60 * 1000;

function did(name: string): string {
  return `did:plc:${name.padEnd(24, 'a')}`;
}

async function seedBlueskyAccount(
  name: string,
  options: { followed: boolean; lastOutboxSyncAt?: Date },
): Promise<string> {
  const uri = did(name);
  await seedActor(scope, {
    protocol: 'atproto',
    uri,
    username: name,
    acct: `${name}.bsky.social`,
    inboxUrl: null,
    outboxUrl: null,
    oxyUserId: scope.user(name),
    lastOutboxSyncAt: options.lastOutboxSyncAt ?? null,
  });
  if (options.followed) {
    await seedFollow(scope, {
      remoteActorUri: uri,
      direction: 'outbound',
      status: 'accepted',
      network: 'atproto',
    });
  }
  return uri;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFederationScope(scope);
});

afterAll(async () => {
  await clearFederationScope(scope);
  await closePostgres();
});

describe('syncFollowedAtprotoAccounts', () => {
  it('reads followed accounts that are due, oldest first, and stamps them', async () => {
    const now = new Date();
    const neverSynced = await seedBlueskyAccount('neversynced', { followed: true });
    const stale = await seedBlueskyAccount('stale', {
      followed: true,
      lastOutboxSyncAt: new Date(now.getTime() - 60 * MINUTE),
    });
    await seedBlueskyAccount('fresh', {
      followed: true,
      lastOutboxSyncAt: new Date(now.getTime() - MINUTE),
    });
    await seedBlueskyAccount('notfollowed', { followed: false });
    mocks.fetchAndUpsertAtprotoProfile.mockImplementation(async (uri: string) => ({
      externalId: uri,
      oxyUserId: 'oxy-owner',
    }));
    mocks.importAuthorFeed.mockResolvedValue({ posts: [] });

    await syncFollowedAtprotoAccounts(now);

    expect(mocks.importAuthorFeed.mock.calls.map(([actor]) => actor.externalId)).toEqual([
      neverSynced,
      stale,
    ]);
    expect((await readActor(stale))?.lastOutboxSyncAt?.getTime()).toBeGreaterThanOrEqual(
      now.getTime(),
    );

    // Both are stamped, so the next tick has nothing to do.
    mocks.importAuthorFeed.mockClear();
    await syncFollowedAtprotoAccounts(new Date(now.getTime() + MINUTE));
    expect(mocks.importAuthorFeed).not.toHaveBeenCalled();
  });
});

describe('advanceAtprotoHistoryBackfills', () => {
  it('pages the author feed from the saved cursor until it ends', async () => {
    const uri = await seedBlueskyAccount('history', { followed: true });
    mocks.fetchAndUpsertAtprotoProfile.mockResolvedValue({
      externalId: uri,
      oxyUserId: scope.user('history'),
    });
    const pages = HISTORY_PAGES_PER_RUN + 2;
    mocks.importAuthorFeed.mockImplementation(async (_actor, { cursor }) => {
      const index = cursor ? Number(cursor) : 0;
      return { posts: [{}], cursor: index + 1 < pages ? String(index + 1) : undefined };
    });

    const first = new Date();
    await advanceAtprotoHistoryBackfills(first);
    expect(mocks.importAuthorFeed).toHaveBeenCalledTimes(HISTORY_PAGES_PER_RUN);
    expect((await readActor(uri))?.outboxBackfill).toMatchObject({
      status: 'pending',
      cursorUrl: String(HISTORY_PAGES_PER_RUN),
      pageCount: HISTORY_PAGES_PER_RUN,
    });

    await advanceAtprotoHistoryBackfills(new Date(first.getTime() + MINUTE));
    expect(mocks.importAuthorFeed.mock.calls[HISTORY_PAGES_PER_RUN][1]).toMatchObject({
      cursor: String(HISTORY_PAGES_PER_RUN),
    });
    expect((await readActor(uri))?.outboxBackfill).toMatchObject({
      status: 'complete',
      pageCount: pages,
      importedCount: pages,
    });

    // A finished account is not picked again.
    mocks.importAuthorFeed.mockClear();
    await advanceAtprotoHistoryBackfills(new Date(first.getTime() + 2 * MINUTE));
    expect(mocks.importAuthorFeed).not.toHaveBeenCalled();
  });
});
