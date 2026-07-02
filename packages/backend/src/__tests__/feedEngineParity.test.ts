import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * DIFFERENTIAL PARITY GATE.
 *
 * Runs the OLD bespoke FeedAPI classes and the NEW engine definitions over the
 * SAME seeded fixtures + context and asserts identical ordered result ids and
 * slice structure. This proves the engine preserves behavior before the old
 * classes are deleted (Task 9). The DB and ranking are mocked deterministically
 * so both paths share identical collaborators; thread slicing, author diversity,
 * cursors and the response builder are REAL (the wrapper under test).
 */

// --- Deterministic fixture the mocked Post model serves for every query. ---
const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);

interface FixtureDoc {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  createdAt: Date;
  _score: number;
  finalScore: number;
  stats: { likesCount: number; boostsCount: number; commentsCount: number };
  visibility: string;
  status: string;
}

let fixture: FixtureDoc[] = [];
function makeFixture(): FixtureDoc[] {
  // Descending createdAt (newest first) AND descending score, distinct authors.
  return [0, 1, 2, 3, 4].map((i) => ({
    _id: oid(i + 1),
    oxyUserId: `author-${i}`,
    createdAt: new Date(2020, 0, 10 - i),
    _score: 100 - i,
    finalScore: 100 - i,
    stats: { likesCount: 10 - i, boostsCount: 0, commentsCount: 0 },
    visibility: 'public',
    status: 'published',
  }));
}
/** Fresh shallow copies so finalScore mutation never leaks across runs. */
function serve(): FixtureDoc[] {
  return fixture.map((d) => ({ ...d }));
}

function chainable() {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    maxTimeMS: () => chain,
    lean: () => Promise.resolve(serve()),
  };
  return chain;
}

vi.mock('../models/Post', () => ({
  Post: {
    find: vi.fn(() => chainable()),
    findOne: vi.fn(() => ({ select: () => ({ sort: () => ({ lean: () => Promise.resolve(serve()[0]) }) }) })),
    aggregate: vi.fn(() => ({ option: () => Promise.resolve(serve()) })),
  },
}));

// Deterministic ranking: finalScore = fixture `_score`.
vi.mock('../services/FeedRankingService', () => ({
  feedRankingService: {
    rankPosts: vi.fn(async (posts: Array<Record<string, unknown>>) => {
      for (const p of posts) p.finalScore = (p._score as number | undefined) ?? 0;
      return posts;
    }),
  },
}));

// Passthrough hydration stamping `id`.
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: Array<{ items: Array<{ post: Record<string, unknown> }> }>) => {
      for (const s of slices) for (const it of s.items) it.post.id = String(it.post._id);
      return slices;
    }),
    hydratePosts: vi.fn(async (posts: Array<Record<string, unknown>>) => {
      for (const p of posts) p.id = String(p._id);
      return posts;
    }),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

vi.mock('../services/FeedSeenPostsService', () => ({
  feedSeenPostsService: {
    getSeenPostIds: vi.fn(async () => []),
    markPostsAsSeen: vi.fn(async () => undefined),
  },
}));

// For You affinity lane resolves candidates via ContentAffinityService (DB) —
// stub it so the affinity lane contributes nothing and never hits the DB.
vi.mock('../services/ContentAffinityService', () => {
  class ContentAffinityService {
    async getContentCandidates() {
      return [];
    }
  }
  return { ContentAffinityService, contentAffinityService: new ContentAffinityService() };
});

// Bookmark model for the Saved feed parity.
const bookmarkFixture = [
  { _id: oid(101), postId: oid(1), createdAt: new Date(2020, 0, 9) },
  { _id: oid(102), postId: oid(2), createdAt: new Date(2020, 0, 8) },
];
vi.mock('../models/Bookmark', () => ({
  default: {
    find: vi.fn(() => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve(bookmarkFixture) }) }) })),
    findOne: vi.fn(() => ({ sort: () => ({ lean: () => Promise.resolve(bookmarkFixture[0]) }) })),
  },
}));

import { ForYouFeed } from '../mtn/feed/feeds/ForYouFeed';
import { FollowingFeed } from '../mtn/feed/feeds/FollowingFeed';
import { ExploreFeed } from '../mtn/feed/feeds/ExploreFeed';
import { VideosFeed } from '../mtn/feed/feeds/VideosFeed';
import { MediaFeed } from '../mtn/feed/feeds/MediaFeed';
import { HashtagFeed } from '../mtn/feed/feeds/HashtagFeed';
import { AuthorFeed } from '../mtn/feed/feeds/AuthorFeed';
import { SavedFeed } from '../mtn/feed/feeds/SavedFeed';
import type { FeedAPI, FeedContext } from '../mtn/feed/FeedAPI';

import { feedEngine } from '../mtn/feed/engine/FeedEngine';
import { registerSourceModules } from '../mtn/feed/engine/sources';
import { registerFilterModules } from '../mtn/feed/engine/filters';
import { registerSignalModules } from '../mtn/feed/engine/signals';
import {
  forYouDefinition,
  followingDefinition,
  exploreDefinition,
  videosDefinition,
  mediaDefinition,
  hashtagDefinition,
  authorDefinition,
  savedDefinition,
} from '../mtn/feed/definitions/presets';
import type { FeedDefinition } from '../mtn/feed/engine/types';

registerSourceModules();
registerFilterModules();
registerSignalModules();

const LIMIT = 30;
const ctx: FeedContext = {
  currentUserId: 'viewer',
  followingIds: ['author-0', 'author-1'],
  subscribedListMemberIds: [],
};

interface ResponseLike { slices: Array<{ items: unknown[] }>; items: Array<{ id?: string }>; }
function itemIds(r: ResponseLike): string[] {
  return r.items.map((i) => i.id ?? '');
}
function sliceShape(r: ResponseLike): number[] {
  return r.slices.map((s) => s.items.length);
}

async function runOld(feed: FeedAPI): Promise<ResponseLike> {
  return (await feed.fetch({ cursor: undefined, limit: LIMIT }, ctx)) as unknown as ResponseLike;
}
async function runNew(def: FeedDefinition): Promise<ResponseLike> {
  return (await feedEngine.run(def, ctx, { limit: LIMIT })) as unknown as ResponseLike;
}

beforeEach(() => {
  fixture = makeFixture();
  vi.clearAllMocks();
});

describe('feed engine parity: old class vs new engine', () => {
  it('for_you', async () => {
    const oldR = await runOld(new ForYouFeed());
    const newR = await runNew(forYouDefinition);
    expect(itemIds(newR)).toEqual(itemIds(oldR));
    expect(sliceShape(newR)).toEqual(sliceShape(oldR));
    expect(itemIds(newR).length).toBeGreaterThan(0);
  });

  it('following', async () => {
    const oldR = await runOld(new FollowingFeed());
    const newR = await runNew(followingDefinition);
    expect(itemIds(newR)).toEqual(itemIds(oldR));
    expect(sliceShape(newR)).toEqual(sliceShape(oldR));
  });

  it('explore', async () => {
    const oldR = await runOld(new ExploreFeed());
    const newR = await runNew(exploreDefinition);
    expect(itemIds(newR)).toEqual(itemIds(oldR));
    expect(sliceShape(newR)).toEqual(sliceShape(oldR));
  });

  it('videos', async () => {
    const oldR = await runOld(new VideosFeed());
    const newR = await runNew(videosDefinition);
    expect(itemIds(newR)).toEqual(itemIds(oldR));
    expect(sliceShape(newR)).toEqual(sliceShape(oldR));
  });

  it('media', async () => {
    const oldR = await runOld(new MediaFeed());
    const newR = await runNew(mediaDefinition);
    expect(itemIds(newR)).toEqual(itemIds(oldR));
    expect(sliceShape(newR)).toEqual(sliceShape(oldR));
  });

  it('hashtag|x', async () => {
    const oldR = await runOld(new HashtagFeed('cats'));
    const newR = await runNew(hashtagDefinition('cats'));
    expect(itemIds(newR)).toEqual(itemIds(oldR));
    expect(sliceShape(newR)).toEqual(sliceShape(oldR));
  });

  it('author|id', async () => {
    const oldR = await runOld(new AuthorFeed('author-0', 'posts'));
    const newR = await runNew(authorDefinition('author-0', 'posts'));
    expect(itemIds(newR)).toEqual(itemIds(oldR));
    expect(sliceShape(newR)).toEqual(sliceShape(oldR));
  });

  it('saved', async () => {
    const oldR = await runOld(new SavedFeed());
    const newR = await runNew(savedDefinition);
    expect(itemIds(newR)).toEqual(itemIds(oldR));
    expect(itemIds(newR).length).toBeGreaterThan(0);
  });
});
