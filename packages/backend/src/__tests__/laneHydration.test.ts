import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * The lane chip on the post DTO.
 *
 * Two failures this guards, and the first one is the reason the chip travels on
 * the DTO at all: a missing field hydrates as `undefined` with NO error, so the
 * chip simply does not appear on one code path while appearing on another — which
 * reads like a caching bug, not a projection bug.
 *
 * The second is the propagation: `buildPostSummary`'s return literal is the only
 * place `lane` is set, and quoted / boosted originals are the SAME objects out of
 * `summaryMap`, so a quoted post gets its own lane for free. That is a property
 * of the hydration graph, not something written per reference — so it needs a
 * test, or a future refactor can break it silently.
 */

const laneFind = vi.fn();
vi.mock('../models/Lane', () => ({
  Lane: { find: (...args: unknown[]) => laneFind(...args) },
}));

function chainReturning(rows: unknown[]) {
  const link = {
    select: () => link,
    sort: () => link,
    limit: () => link,
    lean: () => Promise.resolve(rows),
  };
  return link;
}

const emptyChain = () => chainReturning([]);

/** What the graph collector's `Post.find` answers — referenced posts, if any. */
let referencedPosts: unknown[] = [];
const postFind = vi.fn(() => chainReturning(referencedPosts));
vi.mock('../models/Post', () => ({
  Post: {
    find: (...args: unknown[]) => postFind(...(args as [])),
    aggregate: vi.fn(async () => []),
  },
}));
vi.mock('../models/Like', () => ({ default: { find: () => emptyChain() } }));
vi.mock('../models/Bookmark', () => ({ default: { find: () => emptyChain() } }));
vi.mock('../models/Poll', () => ({ default: { find: () => emptyChain() } }));
vi.mock('../models/FederatedActor', () => ({
  FederatedActor: { find: () => emptyChain() },
  default: { find: () => emptyChain() },
}));
vi.mock('../models/UserSettings', () => ({
  UserSettings: { find: () => emptyChain(), findOne: () => ({ lean: async () => null }) },
  default: { find: () => emptyChain(), findOne: () => ({ lean: async () => null }) },
}));
vi.mock('../services/PostRecentReplierService', () => ({
  loadRecentReplierIds: vi.fn(async () => ({
    perPostRepliers: new Map<string, string[]>(),
    allReplierIds: new Set<string>(),
  })),
}));

import { postHydrationService } from '../services/PostHydrationService';
import { FEED_FIELDS } from '../mtn/feed/FeedAPI';

const LANE_ID = new mongoose.Types.ObjectId().toString();
const laneRow = { _id: LANE_ID, name: 'Notas de Nate', displayMode: 'tab' };

function rawPost(id: string, extra: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(id),
    oxyUserId: 'author-1',
    authorship: [{ oxyUserId: 'author-1', role: 'owner', status: 'accepted' }],
    content: { variants: [{ source: 'author', text: 'hello' }] },
    visibility: 'public',
    status: 'published',
    stats: {},
    metadata: {},
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  referencedPosts = [];
  laneFind.mockReturnValue({ select: () => ({ lean: async () => [laneRow] }) });
});

describe('post hydration — the lane chip', () => {
  it('emits the lane summary on a post that carries one', async () => {
    const [hydrated] = await postHydrationService.hydratePosts(
      [rawPost('507f1f77bcf86cd799439011', { laneId: LANE_ID })],
      { includeLinkMetadata: false },
    );

    expect(hydrated?.lane).toEqual({
      id: LANE_ID,
      name: 'Notas de Nate',
      // `displayMode` travels with the name because the chip's own menu needs it:
      // an owner can see, and change, whether that lane shows on their profile.
      displayMode: 'tab',
    });
  });

  it('omits the field entirely on a post with no lane, and issues no query', async () => {
    const [hydrated] = await postHydrationService.hydratePosts(
      [rawPost('507f1f77bcf86cd799439012')],
      { includeLinkMetadata: false },
    );

    expect(hydrated).toBeDefined();
    expect('lane' in (hydrated ?? {})).toBe(false);
    // The overwhelming majority of posts: it must cost nothing.
    expect(laneFind).not.toHaveBeenCalled();
  });

  it('omits the chip when the lane row is gone rather than rendering a blank one', async () => {
    laneFind.mockReturnValue({ select: () => ({ lean: async () => [] }) });

    const [hydrated] = await postHydrationService.hydratePosts(
      [rawPost('507f1f77bcf86cd799439013', { laneId: LANE_ID })],
      { includeLinkMetadata: false },
    );

    expect(hydrated?.lane).toBeUndefined();
  });

  it('batches every lane in the graph into ONE query', async () => {
    await postHydrationService.hydratePosts(
      [
        rawPost('507f1f77bcf86cd799439014', { laneId: LANE_ID }),
        rawPost('507f1f77bcf86cd799439015', { laneId: LANE_ID }),
      ],
      { includeLinkMetadata: false },
    );

    expect(laneFind).toHaveBeenCalledTimes(1);
    // Deduped: one id, not one per post.
    expect(laneFind).toHaveBeenCalledWith({ _id: { $in: [LANE_ID] } });
  });

  it('propagates to a QUOTED original for free — same object out of summaryMap', async () => {
    const QUOTED_ID = '507f1f77bcf86cd799439021';
    // The graph collector fetches the referenced post by id.
    referencedPosts = [rawPost(QUOTED_ID, { laneId: LANE_ID })];

    const [hydrated] = await postHydrationService.hydratePosts(
      [rawPost('507f1f77bcf86cd799439020', { quoteOf: QUOTED_ID })],
      { includeLinkMetadata: false, maxDepth: 1 },
    );

    // `lane` is set in exactly ONE place — `buildPostSummary`'s return literal —
    // and nested references are the SAME summary objects, so a quoted post
    // carries its own lane with no per-reference code. That is a property of the
    // hydration graph, so a refactor could break it silently.
    expect(hydrated?.quotedPost?.lane).toEqual({
      id: LANE_ID,
      name: 'Notas de Nate',
      displayMode: 'tab',
    });
  });

  it('fails soft: a lane lookup error costs the chip, never the post', async () => {
    laneFind.mockReturnValue({ select: () => ({ lean: async () => { throw new Error('mongo down'); } }) });

    const [hydrated] = await postHydrationService.hydratePosts(
      [rawPost('507f1f77bcf86cd799439016', { laneId: LANE_ID })],
      { includeLinkMetadata: false },
    );

    expect(hydrated).toBeDefined();
    expect(hydrated?.lane).toBeUndefined();
  });
});

/**
 * All FOUR projections, not two.
 *
 * A field missing from one of them hydrates as `undefined` with no error, and the
 * worst spelling of that bug is forgetting the SLICER's: the chip is present on
 * the feed row and absent on the SAME post when it appears as a thread parent,
 * which reads as a caching problem.
 */
describe('laneId is projected on every path that hydrates a post', () => {
  it('is in FEED_FIELDS (the MTN engine)', () => {
    expect(FEED_FIELDS.split(' ')).toContain('laneId');
  });

  it('is in the three other projections', async () => {
    const [{ readFile }, path] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
    ]);
    const root = path.resolve(__dirname, '..');
    const sources = await Promise.all([
      readFile(path.join(root, 'controllers/feed.controller.ts'), 'utf8'),
      readFile(path.join(root, 'services/ThreadSlicingService.ts'), 'utf8'),
      readFile(path.join(root, 'routes/search.ts'), 'utf8'),
    ]);

    // Vacuity floor: the files were really read.
    for (const source of sources) expect(source.length).toBeGreaterThan(1000);

    expect(sources[0]).toMatch(/FEED_FIELDS = '[^']*\blaneId\b/);
    expect(sources[1]).toMatch(/SLICE_POST_PROJECTION =\s*'[^']*\blaneId\b/);
    expect(sources[2]).toMatch(/'laneId',/);
  });
});
