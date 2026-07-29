import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeSearchCursor } from '../../utils/searchCursor';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  select: vi.fn(),
  sort: vi.fn(),
  limit: vi.fn(),
  maxTimeMS: vi.fn(),
  lean: vi.fn(),
  hydratePosts: vi.fn(),
  getProfileByUsername: vi.fn(),
  scopedClient: { kind: 'scoped-client' },
}));

vi.mock('../../models/Post', () => ({
  default: { find: mocks.find },
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: {
    hydratePosts: mocks.hydratePosts,
  },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: () => mocks.scopedClient,
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getProfileByUsername: mocks.getProfileByUsername,
  }),
}));

import searchRoutes from '../../routes/search';

const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { user?: { id: string } }).user = { id: 'viewer-1' };
  next();
});
app.use('/search', searchRoutes);

/** The same router with no session, to exercise the anonymous operator paths. */
const anonApp = express();
anonApp.use('/search', searchRoutes);

function post(id: string, createdAt: string, type = 'post') {
  return {
    _id: new mongoose.Types.ObjectId(id),
    createdAt: new Date(createdAt),
    type,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const chain = {
    select: mocks.select,
    sort: mocks.sort,
    limit: mocks.limit,
    maxTimeMS: mocks.maxTimeMS,
    lean: mocks.lean,
  };
  mocks.find.mockReturnValue(chain);
  mocks.select.mockReturnValue(chain);
  mocks.sort.mockReturnValue(chain);
  mocks.limit.mockReturnValue(chain);
  mocks.maxTimeMS.mockReturnValue(chain);
  mocks.lean.mockResolvedValue([]);
  mocks.hydratePosts.mockImplementation(async (posts: unknown[]) => posts);
});

describe('GET /search post search', () => {
  it('uses the text index and never exposes non-public or unpublished rows', async () => {
    const boost = post('65fdc8c8c8c8c8c8c8c8c8c8', '2026-01-03T00:00:00.000Z', 'boost');
    mocks.lean.mockResolvedValue([boost]);

    await request(app)
      .get('/search')
      .query({ query: 'hello .* world', type: 'posts' })
      .expect(200);

    expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({
      visibility: 'public',
      status: 'published',
      $text: { $search: 'hello .* world' },
    }));
    const filter = mocks.find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter.$or).toBeUndefined();
    expect(mocks.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(mocks.select).toHaveBeenCalledWith(expect.stringContaining('content'));
    expect(mocks.maxTimeMS).toHaveBeenCalledWith(3_000);
    expect(mocks.hydratePosts).toHaveBeenCalledWith([boost], {
      viewerId: 'viewer-1',
      oxyClient: mocks.scopedClient,
      maxDepth: 1,
      includeLinkMetadata: true,
    });
  });

  it('emits and applies a versioned (createdAt, _id) cursor', async () => {
    const first = post('65fdc8c8c8c8c8c8c8c8c8c9', '2026-01-03T00:00:00.000Z');
    const second = post('65fdc8c8c8c8c8c8c8c8c8c8', '2026-01-02T00:00:00.000Z');
    const overfetch = post('65fdc8c8c8c8c8c8c8c8c8c7', '2026-01-01T00:00:00.000Z');
    mocks.lean.mockResolvedValueOnce([first, second, overfetch]).mockResolvedValueOnce([]);

    const firstPage = await request(app)
      .get('/search')
      .query({ type: 'posts', limit: 2 })
      .expect(200);

    expect(firstPage.body.hasMore).toBe(true);
    expect(decodeSearchCursor(firstPage.body.nextCursor)).toEqual({
      createdAt: second.createdAt,
      id: second._id.toString(),
    });

    await request(app)
      .get('/search')
      .query({ type: 'posts', limit: 2, cursor: firstPage.body.nextCursor })
      .expect(200);

    const secondFilter = mocks.find.mock.calls[1][0] as {
      $and: Array<Record<string, unknown>>;
    };
    expect(secondFilter.$and).toEqual([
      {
        $or: [
          { createdAt: { $lt: second.createdAt } },
          {
            createdAt: second.createdAt,
            _id: { $lt: new mongoose.Types.ObjectId(second._id) },
          },
        ],
      },
    ]);
  });

  it('rejects legacy or malformed cursors instead of restarting page one', async () => {
    await request(app)
      .get('/search')
      .query({ type: 'posts', cursor: '65fdc8c8c8c8c8c8c8c8c8c8' })
      .expect(400, { message: 'Invalid search cursor' });

    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.hydratePosts).not.toHaveBeenCalled();
  });

  it('uses the indexed link projection for has:links', async () => {
    await request(app)
      .get('/search')
      .query({ query: 'has:links', type: 'posts' })
      .expect(200);

    const filter = mocks.find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter).toMatchObject({
      visibility: 'public',
      status: 'published',
      hasLinks: true,
    });
    expect(JSON.stringify(filter)).not.toContain('$regex');
  });

  it('matches from: against accepted authorship entries', async () => {
    mocks.getProfileByUsername.mockResolvedValue({ id: 'resolved-author' });

    await request(app)
      .get('/search')
      .query({ query: 'from:alice', type: 'posts' })
      .expect(200);

    expect(mocks.getProfileByUsername).toHaveBeenCalledWith('alice');
    const filter = mocks.find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter).toMatchObject({
      visibility: 'public',
      status: 'published',
      authorship: {
        $elemMatch: {
          oxyUserId: 'resolved-author',
          status: 'accepted',
        },
      },
    });
    expect(filter).not.toHaveProperty('oxyUserId');
  });

  it('strips a leading @ so from:@alice and from:alice resolve the same author', async () => {
    mocks.getProfileByUsername.mockResolvedValue({ id: 'resolved-author' });

    await request(app)
      .get('/search')
      .query({ query: 'from:@alice', type: 'posts' })
      .expect(200);

    // Handed a literal `@alice`, Oxy resolves nobody and the search silently
    // answers "no posts" — which reads as an empty account, not as bad input.
    expect(mocks.getProfileByUsername).toHaveBeenCalledWith('alice');
  });

  it('resolves from:me to the viewer without asking Oxy for a user named "me"', async () => {
    await request(app)
      .get('/search')
      .query({ query: 'from:me coffee', type: 'posts' })
      .expect(200);

    expect(mocks.getProfileByUsername).not.toHaveBeenCalled();
    const filter = mocks.find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter).toMatchObject({
      $text: { $search: 'coffee' },
      authorship: { $elemMatch: { oxyUserId: 'viewer-1', status: 'accepted' } },
    });
  });

  it('returns nothing for from:me when there is no viewer', async () => {
    const res = await request(anonApp)
      .get('/search')
      .query({ query: 'from:me', type: 'posts' })
      .expect(200);

    expect(res.body).toEqual({ posts: [], hasMore: false });
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.getProfileByUsername).not.toHaveBeenCalled();
  });

  it('matches to:username against the indexed mentions array', async () => {
    mocks.getProfileByUsername.mockResolvedValue({ id: 'mentioned-user' });

    await request(app)
      .get('/search')
      .query({ query: 'to:@alice deadline', type: 'posts' })
      .expect(200);

    expect(mocks.getProfileByUsername).toHaveBeenCalledWith('alice');
    const filter = mocks.find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter).toMatchObject({
      $text: { $search: 'deadline' },
      mentions: 'mentioned-user',
    });
  });

  it('resolves to:me to the viewer', async () => {
    await request(app)
      .get('/search')
      .query({ query: 'to:me', type: 'posts' })
      .expect(200);

    expect(mocks.getProfileByUsername).not.toHaveBeenCalled();
    expect(mocks.find.mock.calls[0][0]).toMatchObject({ mentions: 'viewer-1' });
  });

  it('returns nothing for to:me when there is no viewer', async () => {
    const res = await request(anonApp)
      .get('/search')
      .query({ query: 'to:me', type: 'posts' })
      .expect(200);

    expect(res.body).toEqual({ posts: [], hasMore: false });
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it('combines from: and to: into one filter', async () => {
    mocks.getProfileByUsername.mockResolvedValue({ id: 'alice-id' });

    await request(app)
      .get('/search')
      .query({ query: 'from:me to:alice', type: 'posts' })
      .expect(200);

    expect(mocks.getProfileByUsername).toHaveBeenCalledTimes(1);
    expect(mocks.find.mock.calls[0][0]).toMatchObject({
      authorship: { $elemMatch: { oxyUserId: 'viewer-1', status: 'accepted' } },
      mentions: 'alice-id',
    });
  });

  it('returns nothing rather than dropping the filter when to: names an unknown user', async () => {
    mocks.getProfileByUsername.mockResolvedValue(null);

    const res = await request(app)
      .get('/search')
      .query({ query: 'to:nobody', type: 'posts' })
      .expect(200);

    expect(res.body).toEqual({ posts: [], hasMore: false });
    expect(mocks.find).not.toHaveBeenCalled();
  });
});
