import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * ENGINE SNAPSHOT GATE.
 *
 * Originally a differential parity test (old FeedAPI classes vs the engine).
 * After the clean cut removed the bespoke classes, it asserts the engine's
 * output against the GOLDEN ids captured while the old classes still existed and
 * parity was proven — locking in behavior. The DB and ranking are mocked
 * deterministically; thread slicing, author diversity, cursors and the response
 * builder are REAL (the wrapper under test).
 */

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
    aggregate: vi.fn(() => ({ option: () => Promise.resolve(serve()) })),
  },
}));

vi.mock('../services/FeedRankingService', () => ({
  feedRankingService: {
    rankPosts: vi.fn(async (posts: Array<Record<string, unknown>>) => {
      for (const p of posts) p.finalScore = (p._score as number | undefined) ?? 0;
      return posts;
    }),
  },
}));

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

vi.mock('../services/ContentAffinityService', () => {
  class ContentAffinityService {
    async getContentCandidates() {
      return [];
    }
  }
  return { ContentAffinityService, contentAffinityService: new ContentAffinityService() };
});

const bookmarkFixture = [
  { _id: oid(101), postId: oid(1), createdAt: new Date(2020, 0, 9) },
  { _id: oid(102), postId: oid(2), createdAt: new Date(2020, 0, 8) },
];
vi.mock('../models/Bookmark', () => ({
  default: {
    find: vi.fn(() => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve(bookmarkFixture) }) }) })),
  },
}));

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
import type { FeedContext } from '../mtn/feed/FeedAPI';
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
async function run(def: FeedDefinition): Promise<string[]> {
  const r = (await feedEngine.run(def, ctx, { limit: LIMIT })) as unknown as ResponseLike;
  return r.items.map((i) => i.id ?? '');
}

// Golden ids captured while the old FeedAPI classes still existed and the
// differential parity test was green (fixture order = descending score/createdAt).
const ALL = [oid(1), oid(2), oid(3), oid(4), oid(5)].map((o) => o.toString());
const SAVED = [oid(1), oid(2)].map((o) => o.toString());

beforeEach(() => {
  fixture = makeFixture();
  vi.clearAllMocks();
});

describe('feed engine snapshot (behavior locked from proven parity)', () => {
  it('for_you', async () => { expect(await run(forYouDefinition)).toEqual(ALL); });
  it('following', async () => { expect(await run(followingDefinition)).toEqual(ALL); });
  it('explore', async () => { expect(await run(exploreDefinition)).toEqual(ALL); });
  it('videos', async () => { expect(await run(videosDefinition)).toEqual(ALL); });
  it('media', async () => { expect(await run(mediaDefinition)).toEqual(ALL); });
  it('hashtag|x', async () => { expect(await run(hashtagDefinition('cats'))).toEqual(ALL); });
  it('author|id', async () => { expect(await run(authorDefinition('author-0', 'posts'))).toEqual(ALL); });
  it('saved', async () => { expect(await run(savedDefinition)).toEqual(SAVED); });
});
