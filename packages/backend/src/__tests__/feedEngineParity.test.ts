/**
 * ENGINE SNAPSHOT GATE — one seeded corpus, every preset, real rows.
 *
 * This began as a differential parity test (old FeedAPI classes vs the engine)
 * and became a snapshot of GOLDEN IDS once the bespoke classes were removed.
 * Those golden ids were the SAME five for all eight presets, which was only ever
 * a property of the fake: the Mongoose model was stubbed to answer every query
 * with the same documents, so the snapshot proved the engine forwarded a list —
 * not that each preset SELECTS the right posts.
 *
 * Against a real database that fixture cannot exist (`following` wants followed
 * authors, `explore` excludes them), and asserting it would mean re-stubbing the
 * store. So the gate is now: seed one corpus covering every preset's predicate
 * and assert, per preset, exactly which of those posts come back and in what
 * order — thread slicing, author diversity, cursors and the response builder all
 * real, as before. Ranking is still a deterministic stub so the ORDER under test
 * belongs to the engine rather than to the scoring model.
 *
 * ## Why ONE case asserts a property instead of an exact order
 *
 * Every suite shares the single throwaway database `globalSetup` creates, and
 * vitest runs files in parallel. Suites that query directly scope themselves
 * with `where id = any(<their own ids>)` and are immune. This one cannot: it
 * calls the real engine, and the DISCOVERY presets scan the table globally.
 *
 * For the author-scoped, tag-scoped and list-scoped presets that is harmless —
 * their predicates already exclude everything foreign, so their exact order is a
 * property of the code and is asserted as one. `for_you` is different: its pool
 * is global AND author-diversified, and `diversifyByAuthor` interleaves by
 * spacing, so a foreign post can be promoted into the gap between two fixtures
 * by the same author. Filtering the result afterwards does not undo that — the
 * surviving fixtures come back in a different relative order. This suite passed
 * in isolation and failed in the full parallel run on exactly that preset, with
 * two adjacent items swapped.
 *
 * An exact permutation there would be asserting a property of the whole corpus,
 * not of the engine. Per-file database isolation was tried and does NOT work:
 * `config.postgres.url` is read once at module load, so a `DATABASE_URL` set
 * inside `beforeAll` never reaches `connectPostgres`. So `for_you` asserts what
 * IS well-defined — the membership, the leader, and the author-spacing the
 * rerank exists to produce.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { MtnConfig, PostType, PostVisibility } from '@mention/shared-types';

// Deterministic ranking: likes ARE the score, so a ranked preset's order is the
// engine's, not the scoring model's. (The scoring model has its own suites.)
vi.mock('../services/FeedRankingService', () => ({
  feedRankingService: {
    rankPosts: vi.fn(async (posts: Array<Record<string, unknown>>) => {
      for (const post of posts) {
        const stats = post.stats as { likesCount?: number } | undefined;
        post.finalScore = stats?.likesCount ?? 0;
      }
      return posts;
    }),
  },
}));

// Hydration reaches Oxy for author identity; the ids under test are already on
// the candidate, so a passthrough is the whole of what this suite needs.
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: unknown[]) => slices),
    hydratePosts: vi.fn(async (posts: unknown[]) => posts),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

// The affinity lane reaches `ContentAffinityService`, which still loads
// `UserBehavior` from Mongo (its Postgres form needs child-table assembly and
// belongs to the preferences batch). Under the suite's wholesale mongoose mock
// that read never settles, so the whole for_you page times out. This suite is
// about ENGINE orchestration — affinity has its own suite — so the lane is
// stubbed to contribute nothing, exactly as ranking and hydration are.
vi.mock('../services/ContentAffinityService', () => ({
  ContentAffinityService: class {
    async getContentCandidates() {
      return [];
    }
  },
  contentAffinityService: { getContentCandidates: vi.fn(async () => []) },
  default: { getContentCandidates: vi.fn(async () => []) },
}));

vi.mock('../services/FeedSeenPostsService', () => ({
  feedSeenPostsService: {
    getSeenPostIds: vi.fn(async () => []),
    markPostsAsSeen: vi.fn(async () => undefined),
  },
}));

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { bookmarks } from '../db/schema/engagement';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
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

const VIEWER = 'oxy-parity-viewer';
const FOLLOWED = 'oxy-parity-followed';
const STRANGER = 'oxy-parity-stranger';
const PROFILE = 'oxy-parity-profile';
const AUTHORS = [VIEWER, FOLLOWED, STRANGER, PROFILE];

const TAG = 'parityfixture';
/** Comfortably above the corpus, so ordering — never truncation — decides. */
const LIMIT = 100;

let db: Database;
/** id → the name used in the expectations, so a failure reads as a post, not a uuid. */
const created = new Map<string, string>();

const ctx: FeedContext = {
  currentUserId: VIEWER,
  followingIds: [FOLLOWED],
  subscribedListMemberIds: [],
};

function baseInput(author: string, overrides: Partial<PostRecordInput>): PostRecordInput {
  return {
    oxyUserId: author,
    authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'a parity fixture body', tag: 'en' }] },
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Create a post under a NAME, with `likes` engagement (stats are DB-owned, so
 * the writer cannot supply them) — the ranked presets sort on it.
 */
async function seed(
  name: string,
  author: string,
  likes: number,
  overrides: Partial<PostRecordInput> = {},
): Promise<string> {
  const record = await insertPostRecord(baseInput(author, overrides));
  await db.update(posts).set({ statsLikesCount: likes }).where(eq(posts.id, record.id));
  created.set(record.id, name);
  return record.id;
}

/** The page, as fixture NAMES, with every post this suite did not create removed. */
async function run(def: FeedDefinition): Promise<string[]> {
  const response = await feedEngine.run(def, ctx, { limit: LIMIT });
  return response.items
    .map((item) => created.get(String(item.id)))
    .filter((name): name is string => name !== undefined);
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(async () => {
  created.clear();
  // Timestamps are explicit and descending so chronological order is a property
  // of the fixture, not of insertion speed.
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60 * 1000);

  const root = await seed('followed-root', FOLLOWED, 5, {
    hashtags: [TAG],
    createdAt: at(1),
  });
  await seed('followed-reply', FOLLOWED, 4, {
    parentPostId: root,
    createdAt: at(2),
  });
  await seed('stranger-video', STRANGER, 3, {
    type: PostType.VIDEO,
    hashtags: [TAG],
    createdAt: at(3),
    content: {
      variants: [{ source: 'author', text: 'a parity video', tag: 'en' }],
      // The videos lane is the Reels surface: portrait, long enough to be worth
      // auto-advancing to, and with real dimensions. A media row missing any of
      // those is deliberately NOT a candidate.
      media: [{
        id: 'parity-video-1',
        type: 'video',
        orientation: MtnConfig.videosFeed.defaultOrientation,
        durationSec: MtnConfig.videosFeed.minDurationSec,
        width: 720,
        height: 1280,
      }],
    },
  });
  await seed('profile-image', PROFILE, 2, {
    type: PostType.IMAGE,
    createdAt: at(4),
    content: {
      variants: [{ source: 'author', text: 'a parity image', tag: 'en' }],
      media: [{ id: 'parity-image-1', type: 'image' }],
    },
  });
  const saved = await seed('stranger-saved', STRANGER, 1, { createdAt: at(5) });
  await db.insert(bookmarks).values({ userId: VIEWER, postId: saved });
});

afterEach(async () => {
  await db.delete(posts).where(inArray(posts.oxyUserId, AUTHORS));
  created.clear();
});

afterAll(async () => {
  await closePostgres();
});

describe('feed engine snapshot — each preset selects its own posts', () => {
  it('following: followed authors only, newest first, replies carried with context', async () => {
    // A reply is a first-class timeline entry; the preset injects its parent as
    // context, which the slicer emits BEFORE the reply inside one slice — hence
    // the root appearing twice is impossible (it is consumed by the first slice).
    expect(await run(followingDefinition)).toEqual(['followed-root', 'followed-reply']);
  });

  it('hashtag: every post carrying the tag, whoever wrote it', async () => {
    expect(await run(hashtagDefinition(TAG))).toEqual(['followed-root', 'stranger-video']);
  });

  it('author: the profile subject only, and only their top-level posts', async () => {
    expect(await run(authorDefinition(PROFILE, 'posts'))).toEqual(['profile-image']);
    expect(await run(authorDefinition(FOLLOWED, 'posts'))).toEqual(['followed-root']);
    expect(await run(authorDefinition(FOLLOWED, 'replies'))).toEqual(['followed-reply']);
  });

  it('videos: video posts only', async () => {
    expect(await run(videosDefinition)).toEqual(['stranger-video']);
  });

  it('media: every post carrying media, ranked by the stub score', async () => {
    expect(await run(mediaDefinition)).toEqual(['stranger-video', 'profile-image']);
  });

  it('saved: the viewer bookmarks, in bookmark order', async () => {
    expect(await run(savedDefinition)).toEqual(['stranger-saved']);
  });

  it('explore: discovery excludes the viewer own follows and every reply', async () => {
    // Followed authors are what the viewer already has; `explore` is the lane
    // for everything else, and a reply has no standalone context there.
    const page = await run(exploreDefinition);
    expect(page).not.toContain('followed-root');
    expect(page).not.toContain('followed-reply');
    expect(page).toEqual(['stranger-video', 'profile-image', 'stranger-saved']);
  });

  it('for_you: the trusted lane and the discovery lanes merge into one ranked page', async () => {
    // Every fixture is reachable: `followed-root`/`followed-reply` through the
    // trusted following lane, the rest through global discovery.
    //
    // The order is NOT the raw stub score (likes 5,4,3,2,1) descending, and the
    // difference is the point: `followed-root` and `followed-reply` share ONE
    // author, and For You runs `diversifyByAuthor` before page truncation. So
    // the second-highest-scoring post is pushed down the page and a different
    // author takes the slot. `following` (asserted above) keeps the two
    // adjacent, because a chronological feed does not diversify — the two
    // expectations disagreeing is what proves the rerank is running here and
    // only here.
    const page = await run(forYouDefinition);

    // MEMBERSHIP is exact — every fixture is reachable and nothing is dropped.
    expect([...page].sort()).toEqual(
      [
        'followed-root',
        'followed-reply',
        'stranger-video',
        'profile-image',
        'stranger-saved',
      ].sort(),
    );

    // The highest-scoring post leads, whatever else is in the corpus.
    expect(page[0]).toBe('followed-root');

    // And the rerank did its job: the two posts by the SAME author are not
    // adjacent, even though they score 5 and 4 and would be neighbours on score
    // alone. `following` (asserted above) keeps them adjacent because a
    // chronological feed does not diversify — the two expectations disagreeing
    // is what proves the rerank runs here and only here.
    const [rootAt, replyAt] = ['followed-root', 'followed-reply'].map((name) => page.indexOf(name));
    expect(Math.abs(rootAt - replyAt)).toBeGreaterThan(1);
  });
});
