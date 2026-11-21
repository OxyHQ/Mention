import { type Persister, Store, type StoredList, type StoredRecord } from '@oxy.so/bloom-data';
import type { FeedItem } from '@/db/schema';

/**
 * The one synchronous boot read of the home feed, into the store the Oxy
 * session opened for the account.
 */

const mockCopies = new Map<string, { list: StoredList | null; records: StoredRecord[] }>();
const mockOpened: string[] = [];

function mockPersister(account: string): Persister {
  const copy = mockCopies.get(account) ?? { list: null, records: [] };
  return {
    open: async () => undefined,
    openNow: () => {
      mockOpened.push(account);
      return true;
    },
    readList: async () => copy.list,
    readListNow: () => copy.list,
    readRecords: async () => [],
    readRecordsNow: (_type, ids) => copy.records.filter((record) => ids.includes(record.id)),
    write: async () => undefined,
    close: async () => undefined,
    destroy: async () => undefined,
  };
}

// Posts refer to the Oxy SDK's `User`; the real one, without the SDK's UI barrel.
jest.mock('@oxy.so/services/ui/client', () => jest.requireActual('@/test-support/oxyUsers'));

import { bootAccountData } from '../accounts';
import { Feed, feedKey } from '../feeds';
import { getPost } from '../posts';
import { setActiveStore, withStore } from '@oxy.so/bloom-data';

const post = (id: string, extra: Partial<FeedItem> = {}): FeedItem =>
  ({ id, user: { id: 'u' }, engagement: {}, viewerState: {}, ...extra }) as unknown as FeedItem;

const HOME = feedKey({ type: 'for_you' });

/** Every store a test opens, closed after it so none outlives the test. */
const opened: Store[] = [];
function openStore(account: string): Store {
  const store = new Store({ persister: mockPersister(account) });
  opened.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((store) => store.close()));
});

describe('account data', () => {
  it('reads the home feed, its posts and the posts they embed before anything mounts', () => {
    mockCopies.set('alice', {
      list: {
        ids: ['1', '2'],
        json: JSON.stringify({
          extra: { pending: false },
          hasMore: true,
          next: 'c2',
          visited: [],
          updatedAt: 5,
        }),
        records: [
          { id: '1', json: JSON.stringify(post('1', { quotedPost: 'q' as never })) },
          { id: '2', json: JSON.stringify(post('2')) },
        ],
      },
      records: [{ id: 'q', json: JSON.stringify(post('q')) }],
    });

    const alice = openStore('alice');
    setActiveStore(alice);
    bootAccountData(alice);

    expect(mockOpened).toEqual(['alice']);
    expect(Feed.get(HOME)).toMatchObject({ ids: ['1', '2'], next: 'c2', origin: 'disk' });
    expect(getPost('1')?.quotedPost?.id).toBe('q');
  });

  it("reads into the store it is given, never another account's", () => {
    const bob = openStore('bob');
    const carol = openStore('carol');
    setActiveStore(carol);
    bootAccountData(bob);
    // Bob has no copy yet: nothing is shown until his feed is read.
    expect(withStore(bob, () => Feed.get(HOME))).toBeUndefined();
    expect(Feed.get(HOME)).toBeUndefined();
    expect(mockOpened).toContain('bob');
    expect(mockOpened).not.toContain('carol');
  });
});
