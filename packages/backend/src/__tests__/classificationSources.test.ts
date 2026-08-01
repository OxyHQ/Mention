/**
 * The content-classification + discovery SOURCE modules, against a real
 * database: `questions`, `news`, `instance`, `links`, `newVoices`, `topReplies`
 * and `curated`.
 *
 * The suite this replaces mocked `Post.find`/`Post.aggregate` and asserted the
 * KEYS of each query object — including two cases that only ever tested a
 * `RegExp` literal the test itself had pulled back out of the match. Nothing
 * about that told anyone which rows came back, which matters most here because
 * three of these sources carry a HAZARD that returns fewer rows rather than an
 * error:
 *
 *  - **`links` is TWO correlated `EXISTS` subqueries**, one over `post_sources`
 *    and one over `post_content_variants`. The body stopped being a column on
 *    `posts` when renditions became a table, so both halves have to correlate
 *    back to `posts.id`; lose either and "posts linking to X" silently drops
 *    half its answer. Both halves are asserted with a NON-EMPTY exact set.
 *  - **`instance`'s remote match is an ANCHORED host regex.** An unanchored one
 *    hands `evil.com/mastodon.social/…` to anyone browsing `mastodon.social`,
 *    and `mastodon.social` matched inside `evil-mastodon.social`. Both attack
 *    shapes are fixtures.
 *  - **`newVoices` picks each author's LATEST post.** Mongo used `max(_id)`,
 *    which worked only because an ObjectId encodes its creation time. It does
 *    not here, so the fixture gives the OLDER post the LARGER id — the exact
 *    disagreement a surviving `max(id)` would get wrong.
 *
 * Fixtures are stamped fractionally in the FUTURE and corpus-wide reads are
 * compared through {@link suiteIdsOf}: the run shares ONE throwaway database and
 * vitest runs files in parallel, so a capped newest-first sweep of the whole
 * corpus is otherwise a race. Where a predicate already scopes the read to this
 * suite's own marker (a private domain, a private topic slug) {@link idsOf} is
 * used instead, so nothing extra can come back unnoticed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../db/posts/postRecord';
import {
  curatedSource,
  instanceSource,
  linksSource,
  newsSource,
  newVoicesSource,
  questionsSource,
  topRepliesSource,
} from '../mtn/feed/engine/sources/socialSources';
import type { CandidatePost } from '../mtn/feed/engine/types';

let db: Database;
const created: string[] = [];

const AUTHOR = 'classsrc-author';

/** See the module docblock — every fixture leads the corpus in `created_at`. */
const HORIZON = Date.now() + 60_000;

function at(offsetMs: number): Date {
  return new Date(HORIZON + offsetMs);
}

/**
 * Generous enough that a corpus-wide sweep cannot lose this suite's rows to a
 * cap while a sibling suite is inserting. The sources under test take their
 * limit from the caller.
 */
const WIDE_CAP = 500;

async function create(overrides: Partial<PostRecordInput> = {}): Promise<PostRecord> {
  const owner = overrides.oxyUserId === undefined ? AUTHOR : overrides.oxyUserId;
  const record = await insertPostRecord({
    oxyUserId: owner,
    authorship: owner ? [{ oxyUserId: owner, role: 'owner', status: 'accepted' }] : [],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'body' }] },
    createdAt: at(0),
    ...overrides,
  });
  created.push(record.id);
  return record;
}

/** Every id a source returned, in order — for a read the predicate already scopes. */
function idsOf(records: readonly CandidatePost[]): string[] {
  return records.map((record) => record.id);
}

/** The ids THIS suite created, in order — for a read that sweeps the whole corpus. */
function suiteIdsOf(records: readonly CandidatePost[]): string[] {
  const mine = new Set(created);
  return records.map((record) => record.id).filter((id) => mine.has(id));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  const ids = created.splice(0);
  if (ids.length > 0) await db.delete(posts).where(inArray(posts.id, ids));
});

afterAll(async () => {
  await closePostgres();
});

describe('the questions source', () => {
  it('selects the question intent and nothing adjacent to it', async () => {
    const question = await create({
      createdAt: at(0),
      postClassification: { intent: 'question' },
    });
    await create({ postClassification: { intent: 'news' } });
    // An unclassified post defaults to `other`, which must not read as a question.
    await create();
    await create({
      postClassification: { intent: 'question' },
      visibility: PostVisibility.FOLLOWERS_ONLY,
    });

    const gathered = await questionsSource.gather({}, {}, WIDE_CAP);
    expect(suiteIdsOf(gathered)).toEqual([question.id]);
  });
});

describe('the news source', () => {
  it('accepts the news intent OR a news topic, and requires neither of the other', async () => {
    const byIntent = await create({
      createdAt: at(0),
      postClassification: { intent: 'news' },
    });
    const byTopic = await create({
      createdAt: at(-1_000),
      postClassification: { topics: ['news', 'politics'] },
    });
    await create({ postClassification: { intent: 'opinion', topics: ['politics'] } });

    const gathered = await newsSource.gather({}, {}, WIDE_CAP);
    expect(suiteIdsOf(gathered)).toEqual([byIntent.id, byTopic.id]);
  });
});

describe('the instance source', () => {
  it('serves only local posts for the `local` domain', async () => {
    const local = await create({ createdAt: at(0) });
    await create({
      federation: {
        activityId: `https://remote.example/notes/classsrc-${Date.now()}`,
        actorUri: 'https://remote.example/users/bob',
      },
    });

    const gathered = await instanceSource.gather({}, { domain: 'local' }, WIDE_CAP);
    expect(suiteIdsOf(gathered)).toEqual([local.id]);
  });

  /**
   * The host match is ANCHORED (`^https?://<domain>(:port)?/`) and the domain is
   * regex-escaped. Both fixtures below match an UNANCHORED or unescaped pattern
   * and must not match this one — a browse of `classsrc-mastodon.example` that
   * served either would be handing the viewer a different instance's content
   * under that instance's name.
   */
  it('matches the actor host exactly, not a lookalike or a path segment', async () => {
    const genuine = await create({
      createdAt: at(0),
      federation: {
        activityId: `https://classsrc-mastodon.example/notes/a-${Date.now()}`,
        actorUri: 'https://classsrc-mastodon.example/users/bob',
      },
    });
    const withPort = await create({
      createdAt: at(-1_000),
      federation: {
        activityId: `https://classsrc-mastodon.example/notes/b-${Date.now()}`,
        actorUri: 'https://classsrc-mastodon.example:8443/users/carol',
      },
    });
    // The domain appears in the PATH, not the host.
    await create({
      federation: {
        activityId: `https://evil.example/notes/c-${Date.now()}`,
        actorUri: 'https://evil.example/classsrc-mastodon.example/users/mallory',
      },
    });
    // The domain is a SUFFIX of the host.
    await create({
      federation: {
        activityId: `https://not-classsrc-mastodon.example/notes/d-${Date.now()}`,
        actorUri: 'https://not-classsrc-mastodon.example/users/mallory',
      },
    });

    const gathered = await instanceSource.gather(
      {},
      // Mixed case and surrounding whitespace arrive from a URL segment.
      { domain: '  Classsrc-Mastodon.example ' },
      WIDE_CAP,
    );
    expect(idsOf(gathered)).toEqual([genuine.id, withPort.id]);
  });

  it('returns nothing without a domain', async () => {
    await create();
    expect(await instanceSource.gather({}, {}, WIDE_CAP)).toEqual([]);
  });
});

describe('the links source', () => {
  /**
   * The two correlated `EXISTS` halves, each asserted by a post that satisfies
   * ONLY that half.
   *
   * Mutation: drop either `post_id = posts.id` correlation and this goes red
   * — with everything, because the subquery then matches unconditionally.
   * Remove either arm of the `OR` and it goes red by losing exactly one id.
   */
  it('finds the domain in a cited source and in ANY rendition\'s body', async () => {
    const inCitation = await create({
      createdAt: at(0),
      content: {
        variants: [{ source: 'author', text: 'no link in the body' }],
        sources: [{ url: 'https://classsrc-news.example/2026/story', title: 'Story' }],
      },
    });
    const inPrimaryBody = await create({
      createdAt: at(-1_000),
      content: {
        variants: [{ source: 'author', tag: 'en', text: 'read https://classsrc-news.example/2026/x here' }],
      },
    });
    const inTranslatedBody = await create({
      createdAt: at(-2_000),
      content: {
        variants: [
          { source: 'author', tag: 'en', text: 'nothing here' },
          { source: 'machine', tag: 'es', text: 'ver https://www.classsrc-news.example/2026/x' },
        ],
      },
    });
    // A different host that merely CONTAINS the domain name.
    await create({
      content: {
        variants: [{ source: 'author', text: 'https://not-classsrc-news.example/2026/x' }],
      },
    });
    await create({ content: { variants: [{ source: 'author', text: 'no links at all' }] } });

    const gathered = await linksSource.gather({}, { domain: 'classsrc-news.example' }, WIDE_CAP);
    expect(idsOf(gathered)).toEqual([inCitation.id, inPrimaryBody.id, inTranslatedBody.id]);
  });

  it('returns nothing without a domain', async () => {
    await create({ content: { variants: [{ source: 'author', text: 'https://classsrc-news.example/x' }] } });
    expect(await linksSource.gather({}, {}, WIDE_CAP)).toEqual([]);
  });
});

describe('the newVoices source', () => {
  it('returns each low-volume author\'s LATEST post, even when the id order disagrees', async () => {
    /**
     * Mongo picked the latest post with `max(_id)`, which was only ever correct
     * because an ObjectId encodes its creation time. Here the newer post is
     * given the SMALLER id, so a surviving `max(id)` returns the older one and
     * this goes red naming it.
     */
    const older = await create({
      oxyUserId: 'classsrc-newcomer',
      id: 'ffffffffffffffffffffff01',
      createdAt: at(-60_000),
    });
    const newest = await create({
      oxyUserId: 'classsrc-newcomer',
      id: '00000000000000000000ff01',
      createdAt: at(0),
    });

    const gathered = await newVoicesSource.gather({}, {}, WIDE_CAP);
    expect(suiteIdsOf(gathered)).toEqual([newest.id]);
    expect(suiteIdsOf(gathered)).not.toContain(older.id);
  });

  it('drops an author who is past the low-volume ceiling, and one who is only sensitive', async () => {
    // A prolific author is not a new voice. Written straight to `posts` — the
    // source groups on `posts.oxy_user_id` and reads nothing from the child
    // tables, so 21 full records would only buy 21 extra transactions.
    const bulk = await db
      .insert(posts)
      .values(
        Array.from({ length: 21 }, (_unused, index) => ({
          oxyUserId: 'classsrc-prolific',
          createdAt: at(-index * 1_000),
        })),
      )
      .returning({ id: posts.id });
    created.push(...bulk.map((row) => row.id));

    await create({ oxyUserId: 'classsrc-sensitive', postClassification: { sensitive: true } });
    await create({ oxyUserId: 'classsrc-nsfw', hashtags: ['nsfw'] });
    const root = await create({ oxyUserId: 'classsrc-replier', createdAt: at(-5_000) });
    await create({ oxyUserId: 'classsrc-replier', parentPostId: root.id });
    const quiet = await create({ oxyUserId: 'classsrc-quiet', createdAt: at(0) });

    const gathered = await newVoicesSource.gather({}, {}, WIDE_CAP);
    // `classsrc-replier` still qualifies through its ROOT post; the reply is
    // never the one returned, because replies are excluded from the grouping.
    expect(suiteIdsOf(gathered)).toEqual([quiet.id, root.id]);
  });
});

describe('the topReplies source', () => {
  /** Set the denormalized engagement counters the composite reads. */
  async function setEngagement(
    postId: string,
    counts: { likes?: number; boosts?: number; comments?: number },
  ): Promise<void> {
    await db
      .update(posts)
      .set({
        statsLikesCount: counts.likes ?? 0,
        statsBoostsCount: counts.boosts ?? 0,
        statsCommentsCount: counts.comments ?? 0,
      })
      .where(eq(posts.id, postId));
  }

  it('ranks replies by the engagement composite and keeps that order after fetching', async () => {
    const root = await create({ createdAt: at(-10_000) });
    const best = await create({ parentPostId: root.id, createdAt: at(-1_000) });
    const middle = await create({ parentPostId: root.id, createdAt: at(-2_000) });
    const worst = await create({ parentPostId: root.id, createdAt: at(-3_000) });
    // A root post is not a reply, however popular.
    const popularRoot = await create({ createdAt: at(-4_000) });
    const sensitiveReply = await create({ parentPostId: root.id, metadata: { isSensitive: true } });

    // Deliberately inverse to `created_at`, so a fallback to chronological
    // order cannot pass: 3 comments (×2) + 1 boost (×2.5) = 8.5 > 5 likes > 1.
    await setEngagement(best.id, { comments: 3, boosts: 1 });
    await setEngagement(middle.id, { likes: 5 });
    await setEngagement(worst.id, { likes: 1 });
    await setEngagement(popularRoot.id, { likes: 9_000 });
    await setEngagement(sensitiveReply.id, { likes: 9_000 });

    const gathered = await topRepliesSource.gather({}, {}, WIDE_CAP);
    expect(suiteIdsOf(gathered)).toEqual([best.id, middle.id, worst.id]);
  });
});

describe('the curated source', () => {
  it('selects curated posts by equality, so an unset flag is not curated', async () => {
    // The column is NULLABLE with a partial index — only curated posts carry a
    // value at all — which is why the source tests equality rather than
    // truthiness. A NULL and a `false` must both stay out.
    const curated = await create({ createdAt: at(0) });
    const notCurated = await create({ createdAt: at(-1_000) });
    const unset = await create({ createdAt: at(-2_000) });
    await db.update(posts).set({ curated: true }).where(eq(posts.id, curated.id));
    await db.update(posts).set({ curated: false }).where(eq(posts.id, notCurated.id));

    const gathered = await curatedSource.gather({}, {}, WIDE_CAP);
    expect(suiteIdsOf(gathered)).toEqual([curated.id]);
    expect(suiteIdsOf(gathered)).not.toContain(unset.id);
  });
});
