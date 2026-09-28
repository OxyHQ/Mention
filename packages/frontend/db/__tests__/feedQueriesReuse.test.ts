import { getDb, isDbAvailable } from '../database';
import { getAllFeedItems } from '../feedQueries';
import { postToRow, type FeedItem } from '../schema';

jest.mock('../database', () => ({
  getDb: jest.fn(),
  isDbAvailable: jest.fn(),
}));

const mockGetDb = getDb as jest.Mock;
const mockIsDbAvailable = isDbAvailable as jest.Mock;

function makePost(id: string): FeedItem {
  return {
    id,
    content: { text: `post ${id}` },
    attachments: {},
    documents: [],
    user: { id: 'user-1', username: 'alice', name: { displayName: 'Alice' } },
    authors: [],
    engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0, saves: 0, views: 0, impressions: 0 },
    viewerState: {
      isOwner: false, isCollaborator: false, isLiked: false, isDownvoted: false, isBoosted: false, isSaved: false,
    },
    permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
    metadata: {
      visibility: 'public',
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    },
  } as FeedItem;
}

/**
 * Reading a feed with `reuse` parses only the posts the caller does not already
 * hold. Without it every page, refresh and realtime insert re-read and re-parsed
 * every row the feed had loaded — O(n²) JSON parsing on the JS thread over a
 * session.
 */
describe('getAllFeedItems with reuse', () => {
  const rows = new Map(['a', 'b', 'c'].map((id) => [id, postToRow(makePost(id))]));
  let getAllSync: jest.Mock;

  beforeEach(() => {
    mockIsDbAvailable.mockReturnValue(true);
    getAllSync = jest.fn((query: string, ...params: string[]) => {
      if (query.includes('SELECT fi.post_id')) {
        return ['a', 'b', 'c', 'gone'].map((post_id) => ({ post_id }));
      }
      if (query.includes('WHERE id IN')) {
        return params.map((id) => rows.get(id)).filter(Boolean);
      }
      throw new Error(`unexpected query: ${query}`);
    });
    mockGetDb.mockReturnValue({ getAllSync });
  });

  it('fetches only the posts the cache cannot answer, in feed order', () => {
    const cachedA = makePost('a');
    const items = getAllFeedItems('home', (id) => (id === 'a' ? cachedA : undefined));

    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    // The cached post is served as-is, not re-parsed.
    expect(items[0]).toBe(cachedA);
    const fetchCall = getAllSync.mock.calls.find(([query]) => String(query).includes('WHERE id IN'));
    expect(fetchCall?.slice(1)).toEqual(['b', 'c', 'gone']);
  });

  it('issues no post read at all when every post is cached', () => {
    const cached = new Map(['a', 'b', 'c', 'gone'].map((id) => [id, makePost(id)]));
    const items = getAllFeedItems('home', (id) => cached.get(id));

    expect(items).toHaveLength(4);
    expect(getAllSync).toHaveBeenCalledTimes(1);
  });

  it('drops a feed entry whose post no longer exists, as the join did', () => {
    const items = getAllFeedItems('home', () => undefined);
    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});
