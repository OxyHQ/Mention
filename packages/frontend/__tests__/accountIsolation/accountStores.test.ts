/**
 * What Mention STORES stays per account on Services 15: each account's posts,
 * feeds and people (the SDK's `User`, which Services 15 keeps in the account's
 * bloom-data store) live in that account's own store and file
 * (`data/accounts.ts`, `mention-data-<account>.db`).
 *
 * - An answer read for A that lands after the switch to B is written nowhere
 *   (`actorWriter`, taken before the request).
 * - A cold boot as B paints B's copy only, whatever A left on the device.
 * - Sign-out deletes the account's file (`forgetAccountData`, from the
 *   session follower); a switch keeps it for the account's return.
 */
import type { Persister, StoredList, StoredRecord } from '@oxy.so/bloom-data';
import { QueryClient } from '@tanstack/react-query';
import type { FeedItem } from '@/db/schema';

const mockCopies = new Map<string, { list: StoredList | null; records: StoredRecord[] }>();
const mockWrites = new Map<string, string[]>();
const mockDestroyed: string[] = [];

function mockPersister(account: string): Persister {
  const copy = () => mockCopies.get(account) ?? { list: null, records: [] };
  return {
    open: async () => undefined,
    destroy: async () => {
      mockDestroyed.push(account);
      mockCopies.delete(account);
    },
    openNow: () => true,
    readList: async () => copy().list,
    readListNow: () => copy().list,
    readRecords: async () => [],
    readRecordsNow: (_type, ids) => copy().records.filter((record) => ids.includes(record.id)),
    write: async (batch) => {
      const written = mockWrites.get(account) ?? [];
      written.push(JSON.stringify(batch));
      mockWrites.set(account, written);
    },
    close: async () => undefined,
  };
}

jest.mock('@/data/persister', () => ({
  accountPersister: (account: string) => mockPersister(account),
}));
jest.mock('@oxy.so/services/ui/client', () => require('@/test-support/oxyUsers').oxyUsers);

import { withStore } from '@oxy.so/bloom-data';
import { User } from '@oxy.so/services/ui/client';
import { forgetAccountData, openAccountData } from '@/data/accounts';
import { Feed, feedKey } from '@/data/feeds';
import { getPost } from '@/data/posts';
import { actorWriter } from '@/lib/actorCache';
import { activateAccount, followOxyRuntime, resetAccountScopeForTests } from '@/lib/accountScope';
import { createRuntime } from '@/test-support/accountIsolation';

const HOME = feedKey({ type: 'for_you' });
const client = new QueryClient();
const post = (id: string, author: string): FeedItem =>
  ({ id, user: { id: author }, engagement: {}, viewerState: {} }) as unknown as FeedItem;
const homeCopy = (posts: FeedItem[]) => ({
  list: {
    ids: posts.map((item) => item.id),
    json: JSON.stringify({ hasMore: false, visited: [], updatedAt: 5 }),
    records: posts.map((item) => ({ id: item.id, json: JSON.stringify(item) })),
  },
  records: [],
});

afterEach(() => {
  mockCopies.clear();
  mockWrites.clear();
  mockDestroyed.length = 0;
  resetAccountScopeForTests();
});

it('writes an answer read for A nowhere once the session has moved to B', async () => {
  activateAccount('A', client);
  const storeA = openAccountData('A');
  const forA = actorWriter();

  activateAccount('B', client);
  const storeB = openAccountData('B');
  expect(storeA.closed).toBe(true);

  // A's request answers late, with A's view of the person (A follows them).
  forA.cacheActors([
    { id: 'person', username: 'a-private-handle', relationship: { following: true } } as never,
  ]);
  expect(withStore(storeB, () => User.get('person'))).toBeUndefined();
  expect(withStore(storeA, () => User.get('person'))).toBeUndefined();
  await Promise.resolve();
  expect(JSON.stringify([...mockWrites.values()])).not.toContain('a-private-handle');

  // B's own read lands in B's store, and only there.
  actorWriter().cacheActors([{ id: 'person', username: 'b-view' } as never]);
  expect(withStore(storeB, () => User.get('person'))?.username).toBe('b-view');
});

it('paints only B’s copy on a cold boot as B, whatever A left on the device', () => {
  mockCopies.set('A', homeCopy([post('a-private-1', 'A'), post('a-private-2', 'A')]));
  mockCopies.set('B', homeCopy([post('b-own-1', 'B')]));
  // Another account's store is open, as after any earlier session.
  openAccountData('someone-else');

  activateAccount('B', client);
  openAccountData('B');

  expect(Feed.get(HOME)?.ids).toEqual(['b-own-1']);
  expect(getPost('b-own-1')?.id).toBe('b-own-1');
  expect(getPost('a-private-1')).toBeNull();
  expect(getPost('a-private-2')).toBeNull();
});

it('deletes the account’s file on sign-out, and keeps it across a switch', async () => {
  const runtime = createRuntime('A');
  const unfollow = followOxyRuntime(runtime, client, (id) => {
    void forgetAccountData(id);
  });
  openAccountData('A');

  runtime.become('B');
  openAccountData('B');
  await Promise.resolve();
  expect(mockDestroyed).toEqual([]);

  runtime.become(null);
  openAccountData('anon');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(mockDestroyed).toEqual(['B']);
  unfollow();
});
