import type { Persister, StoredList, StoredRecord } from '@oxy.so/bloom-data';
import type { FeedItem } from '@/db/schema';

/**
 * Each account's store, and the one synchronous boot read of the home feed.
 */

const mockCopies = new Map<string, { list: StoredList | null; records: StoredRecord[] }>();
const mockOpened: string[] = [];

function mockPersister(account: string): Persister {
  const copy = mockCopies.get(account) ?? { list: null, records: [] };
  return {
    open: async () => undefined,
    destroy: async () => undefined,
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
  };
}

jest.mock('../persister', () => ({
  accountPersister: (account: string) => mockPersister(account),
}));
jest.mock('@/lib/precacheActorsFromPosts', () => ({ precacheActorsFromPosts: jest.fn() }));

import { openAccountData } from '../accounts';
import { Feed, feedKey } from '../feeds';
import { getPost } from '../posts';

const post = (id: string, extra: Partial<FeedItem> = {}): FeedItem =>
  ({ id, user: { id: 'u' }, engagement: {}, viewerState: {}, ...extra }) as unknown as FeedItem;

const HOME = feedKey({ type: 'for_you' });

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

    openAccountData('alice');

    expect(mockOpened).toEqual(['alice']);
    expect(Feed.get(HOME)).toMatchObject({ ids: ['1', '2'], next: 'c2', origin: 'disk' });
    expect(getPost('1')?.quotedPost?.id).toBe('q');
  });

  it('keeps an open account’s store, and gives another account its own', () => {
    const alice = openAccountData('alice');
    expect(openAccountData('alice')).toBe(alice);
    expect(mockOpened).toEqual(['alice']);

    const bob = openAccountData('bob');
    expect(bob).not.toBe(alice);
    expect(alice.closed).toBe(true);
    // Bob has no copy yet: nothing is shown until his feed is read.
    expect(Feed.get(HOME)).toBeUndefined();
    expect(getPost('1')).toBeNull();
  });
});
