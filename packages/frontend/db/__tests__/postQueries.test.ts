import { getDb, isDbAvailable } from '../database';
import { updatePost } from '../postQueries';
import { postToRow, type FeedItem, type PostRow } from '../schema';

jest.mock('../database', () => ({
  getDb: jest.fn(),
  isDbAvailable: jest.fn(),
}));

const mockGetDb = getDb as jest.Mock;
const mockIsDbAvailable = isDbAvailable as jest.Mock;

function makePost(): FeedItem {
  return {
    id: 'post-1',
    content: { text: 'kept in feed' },
    attachments: {},
    linkPreviews: [],
    user: {
      id: 'user-1',
      username: 'alice',
      name: { displayName: 'Alice' },
    },
    authors: [{
      id: 'user-1',
      username: 'alice',
      name: { displayName: 'Alice' },
      role: 'owner',
      status: 'accepted',
    }],
    engagement: {
      likes: 0,
      downvotes: 0,
      boosts: 0,
      replies: 0,
      saves: 0,
      views: 0,
      impressions: 0,
    },
    viewerState: {
      isOwner: false,
      isCollaborator: false,
      isLiked: false,
      isDownvoted: false,
      isBoosted: false,
      isSaved: false,
    },
    permissions: {
      canReply: true,
      canDelete: false,
      canPin: false,
      canViewSources: false,
    },
    metadata: {
      visibility: 'public',
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    },
  } as FeedItem;
}

describe('native post updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsDbAvailable.mockReturnValue(true);
  });

  it('updates a post without SQLite REPLACE deleting its feed memberships', () => {
    const storedRow: PostRow = postToRow(makePost());
    const runSync = jest.fn((sql: string, ..._params: unknown[]) => ({
      changes: sql.length > 0 ? 1 : 0,
      lastInsertRowId: 0,
    }));
    mockGetDb.mockReturnValue({
      execSync: jest.fn(),
      runSync,
      getFirstSync: jest.fn(() => storedRow),
      getAllSync: jest.fn(() => []),
      closeSync: jest.fn(),
    });

    const updated = updatePost('post-1', (post) => ({
      ...post,
      viewerState: { ...post.viewerState, isLiked: true },
      engagement: { ...post.engagement, likes: 1 },
    }));

    expect(updated?.viewerState.isLiked).toBe(true);
    const postWrite = runSync.mock.calls.find(([sql]) =>
      String(sql).includes('INTO posts'),
    );
    expect(postWrite?.[0]).toContain('ON CONFLICT(id) DO UPDATE SET');
    expect(postWrite?.[0]).not.toContain('INSERT OR REPLACE');
  });
});
