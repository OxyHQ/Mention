/**
 * One Meta cross-post is ONE card, on every surface that chooses what to show.
 *
 * WHY the collapse exists, WHICH surfaces are exempt and WHY it is a query term
 * rather than a post-fetch filter are all argued once, at
 * {@link notCollapsedCrosspostSql} in `utils/feedQueryBuilder.ts`. This file does
 * not restate any of it. What follows is only what is peculiar to testing it.
 *
 * ## Why a suite rather than trusting the predicate
 *
 * The term is spelled at ~50 call sites, and the failure mode of forgetting one
 * is silent: the page still pages, nothing errors, and the only symptom is a
 * reader meeting the same photo twice under the same name. Nothing about the
 * predicate's own correctness can catch that — only driving the shipped surfaces
 * over a real cluster can. It caught three omissions on the commit that added it.
 *
 * ## Every case is DIFFERENTIAL, and that is what makes it evidence
 *
 * Each surface is asked twice over the same rows: once while the cluster exists,
 * once after `dissolveCluster` un-collapses them. "One id, then two" is a claim
 * about the predicate; "one id" alone would also pass for a surface that simply
 * never reached the fixtures — the exact way a capped corpus-wide read goes
 * quietly green in a shared database.
 *
 * ## The exempt surfaces are asserted here too
 *
 * Bookmarks and the profile likes tab must return BOTH, so that exemption is a
 * decision on the record rather than an omission the next reader of
 * `feedQueryBuilder.ts` tidies away.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, inArray, type SQL } from 'drizzle-orm';
import { MtnConfig, PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { bookmarks, likes, posts } from '../db/schema';
import { dissolveCluster } from '../db/posts/postEquivalenceRepository';
import { clearPostScope, postScope, seedCrosspostCluster, seedPost } from './helpers/postFixtures';
import { FeedQueryBuilder } from '../utils/feedQueryBuilder';
import { buildPostsByHashtagFilter, buildPostsByTopicFilter } from '../controllers/posts/readPosts';
import { buildActorPostsScopeSql } from '../connectors/connectors.routes';
import { chronoOrderBy } from '../mtn/feed/CursorBuilder';
import { mediaSource, videosSource } from '../mtn/feed/engine/sources/discoverySources';
import { followingSource } from '../mtn/feed/engine/sources/forYouSources';
import { authoredSource, savedSource } from '../mtn/feed/engine/sources/userSources';
import { moreLikeThisSource } from '../mtn/feed/engine/sources/relatedSources';
import type { CandidatePost, FeedEngineContext } from '../mtn/feed/engine/types';

const scope = postScope('crosspost-collapse-surfaces');
const AUTHOR = scope.user('author');
const VIEWER = scope.user('viewer');
const STRANGER = scope.user('stranger');

/**
 * A tag and a topic no other suite uses, so the naturally-scoped surfaces
 * (`moreLikeThis`) match this file's rows and nothing else.
 */
const TAG = 'crosspostcollapsegate';
const TOPIC = 'crosspost-collapse-gate';

/**
 * Far in the future, so the corpus-wide lanes (`videos`, `media`) sort this
 * file's rows above whatever else the shared database holds and a page of 60 is
 * these fixtures rather than a sample of another suite's.
 *
 * Deliberately a different year from `mtn/videosLaneChrono.test.ts` (2099),
 * which seeds the same lanes: two suites stamping the same instant would decide
 * each other's page order by id.
 */
const BASE = new Date('2097-01-01T00:00:00.000Z');
const at = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);

const PORTRAIT = { width: 720, height: 1280, orientation: 'portrait' as const };
const LONG_ENOUGH = MtnConfig.videosFeed.minDurationSec + 5;

/**
 * The ids this suite created, in seeding order.
 *
 * `postFixtures` keeps its own list module-private for teardown, and
 * {@link suiteIdsOf} needs to read it — so the ids are tracked twice
 * deliberately, rather than re-implementing the insert to get at one.
 */
const created: string[] = [];

/**
 * A public, published, qualifying-video post carrying the suite's tag and topic.
 *
 * FEDERATED, because a cross-post always is: the remote-actor page selects on
 * `federation.activityId is not null`, and a native post could never be a
 * cluster member in the first place (`detectCrosspostEquivalence` requires two
 * authoring actors on a reviewed pair of networks).
 */
async function seedVariant(
  label: string,
  createdAt: Date,
  owner: string = AUTHOR,
): Promise<string> {
  const record = await seedPost(scope, {
    oxyUserId: owner,
    authorship: [{ oxyUserId: owner, role: 'owner', status: 'accepted' }],
    type: PostType.VIDEO,
    visibility: PostVisibility.PUBLIC,
    createdAt,
    hashtags: [TAG],
    federation: { activityId: `https://source.test/${label}-${createdAt.getTime()}` },
    postClassification: { topics: [TOPIC] },
    content: {
      variants: [{ source: 'author', tag: 'en', text: `${label} #${TAG}` }],
      media: [{ id: `${label}-media`, type: 'video', durationSec: LONG_ENOUGH, ...PORTRAIT }],
    },
  } as never);
  created.push(record.id);
  return record.id;
}

interface Pair {
  /** The rendered representative — the Instagram variant here. */
  shown: string;
  /** The collapsed one — the Threads variant. */
  hidden: string;
  clusterId: string;
}

/** Two variants of one cross-post, clustered through the shipped writer. */
async function crosspostPair(): Promise<Pair> {
  const shown = await seedVariant('instagram-variant', at(20));
  const hidden = await seedVariant('threads-variant', at(10));
  return { shown, hidden, clusterId: await seedCrosspostCluster(shown, hidden) };
}

/** The ids THIS suite created, in order — for a read that sweeps the whole corpus. */
function suiteIdsOf(records: readonly CandidatePost[]): string[] {
  const mine = new Set(created);
  return records.map((record) => record.id).filter((id) => mine.has(id));
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  created.length = 0;
  // Bookmarks, likes, media, authorships and cluster membership go with the post
  // by `ON DELETE cascade` — see `db/schema/engagement.ts`.
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

/**
 * Ask one surface twice: with the cluster, then without it.
 *
 * The second half is the control. A surface that returns `[shown]` because it
 * never saw either row is indistinguishable from one that excluded the collapsed
 * half, until the cluster is dissolved and both are required back.
 */
async function expectsCollapse(
  pair: Pair,
  read: () => Promise<string[]>,
): Promise<void> {
  expect(await read()).toEqual([pair.shown]);
  await dissolveCluster(pair.clusterId);
  expect(await read()).toEqual([pair.shown, pair.hidden]);
}

describe('the content predicates, driven directly', () => {
  /**
   * The six exported predicates behind a reader surface that pages over `posts`
   * without going through a source module.
   *
   * Scoped rather than corpus-wide because these are predicates, not pages:
   * `inArray` makes "exactly these two rows, filtered" a determinate question in
   * a database other files are writing to, and the lanes themselves are driven
   * end-to-end further down.
   */
  async function matching(where: SQL): Promise<string[]> {
    const rows = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(and(where, inArray(posts.id, created)))
      .orderBy(...chronoOrderBy());
    return [...rows].map((row) => row.id);
  }

  it.each<[string, () => SQL]>([
    ['the ranked video predicate', () => FeedQueryBuilder.buildVideosQuery([])],
    ['the chronological video predicate', () => FeedQueryBuilder.videoPostConditions([])],
    ['the media predicate', () => FeedQueryBuilder.buildMediaFeedQuery([])],
    ['the hashtag page', () => buildPostsByHashtagFilter(TAG)],
    ['the topic page', () => buildPostsByTopicFilter(TOPIC)],
    // One Oxy person owning BOTH source actors of a proven Instagram ↔ Threads
    // pair is the whole reason this branch needs the term: it selects by
    // `oxy_user_id`, so both halves land on one remote actor's page.
    ["an adopted actor's page",
      () => buildActorPostsScopeSql({ uri: 'https://kilogram.makeup/users/gate', oxyUserId: AUTHOR })],
  ])('excludes the collapsed half from %s', async (_label, predicate) => {
    const pair = await crosspostPair();
    await expectsCollapse(pair, () => matching(predicate()));
  });
});

describe('the reader surfaces that choose what to show', () => {
  it('shows one card in the Videos lane', async () => {
    const pair = await crosspostPair();
    await expectsCollapse(pair, async () =>
      suiteIdsOf(await videosSource.gather({} as FeedEngineContext, {}, 60)));
  });

  it('shows one card in the Media lane', async () => {
    const pair = await crosspostPair();
    await expectsCollapse(pair, async () =>
      suiteIdsOf(await mediaSource.gather({} as FeedEngineContext, {}, 60)));
  });

  it('shows one card in the following timeline', async () => {
    const pair = await crosspostPair();
    const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [AUTHOR], seenPostIds: [] };
    await expectsCollapse(pair, async () =>
      suiteIdsOf(await followingSource.gather(ctx, { timeline: true }, 60)));
  });

  it('shows one card on the profile timeline', async () => {
    const pair = await crosspostPair();
    await expectsCollapse(pair, async () =>
      suiteIdsOf(await authoredSource.gather(
        { currentUserId: VIEWER },
        { authorId: AUTHOR, filter: 'posts' },
        60,
      )));
  });

  it('recommends one card, not two, from the same cross-post', async () => {
    const pair = await crosspostPair();
    // Naturally scoped: the seed names this suite's own hashtag.
    await expectsCollapse(pair, async () => {
      const gathered = await moreLikeThisSource.gather(
        { currentUserId: VIEWER } as FeedEngineContext,
        { hashtags: [TAG] },
        60,
      );
      // `moreLikeThis` ranks by overlap score; both variants score identically,
      // so the order is the chronological tie-break the pool was read in.
      return suiteIdsOf(gathered);
    });
  });
});

describe('the collections a reader assembled by hand', () => {
  it('keeps both source posts in bookmarks', async () => {
    const pair = await crosspostPair();
    await getDb().insert(bookmarks).values([
      { userId: VIEWER, postId: pair.shown, createdAt: at(20) },
      { userId: VIEWER, postId: pair.hidden, createdAt: at(10) },
    ]);

    const saved = await savedSource.gather({ currentUserId: VIEWER, pageLimit: 10 }, {}, 10);
    expect(suiteIdsOf(saved)).toEqual([pair.shown, pair.hidden]);
  });

  it('keeps both source posts on the likes tab', async () => {
    // The likes tab lists posts the profile owner liked, so the variants are
    // somebody else's — which is also why the collapse would be least expected
    // here: the reader is looking at their own record of what they liked.
    const shown = await seedVariant('liked-instagram', at(20), STRANGER);
    const hidden = await seedVariant('liked-threads', at(10), STRANGER);
    await seedCrosspostCluster(shown, hidden);
    // Explicit instants: the likes tab pages over the LIKE, so its order is
    // `likes.(created_at, id)` and two rows sharing a default timestamp would
    // leave the assertion resting on id order.
    await getDb().insert(likes).values([
      { userId: VIEWER, postId: shown, value: 1, createdAt: at(20) },
      { userId: VIEWER, postId: hidden, value: 1, createdAt: at(10) },
    ]);

    const tab = await authoredSource.gather(
      { currentUserId: VIEWER, pageLimit: 10 },
      { authorId: VIEWER, filter: 'likes' },
      10,
    );
    expect(suiteIdsOf(tab)).toEqual([shown, hidden]);
  });
});

describe('pagination', () => {
  /** The observable consequence of `IT IS A QUERY TERM` in the predicate's docblock. */
  it('fills the requested page with visible posts, not with collapsed ones', async () => {
    const pair = await crosspostPair();
    const third = await seedVariant('unrelated-visible', at(5));

    const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [AUTHOR], seenPostIds: [] };
    const page = suiteIdsOf(await followingSource.gather(ctx, { timeline: true }, 2));
    expect(page).toEqual([pair.shown, third]);
  });
});
