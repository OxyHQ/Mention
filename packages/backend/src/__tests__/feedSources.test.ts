/**
 * The engine SOURCE modules, against a real database.
 *
 * The suite this replaces mocked `Post.find` and asserted the KEYS of the query
 * object each source built. That is dead twice over: there is no query object to
 * inspect any more, and a query shape never proved the rows were right — a
 * predicate that renders a correlated column BARE compiles, runs, matches
 * nothing and raises nothing. So every case below states an exact id set.
 *
 * Four guarantees are load-bearing here, and each is the reason its case exists:
 *
 *  1. **Authorship is a CORRELATED subquery.** `followedAuthorsSql` /
 *     `authorFeedSql` are `exists (select 1 from post_authorships where post_id
 *     = posts.id …)`. Mis-render the correlation and every author feed is simply
 *     EMPTY, with no error. Each case asserts a NON-EMPTY exact set, including a
 *     post the author only COLLABORATED on.
 *  2. **Root-vs-reply is the stored `is_reply`, in BOTH directions.** The
 *     profile `posts` tab used to let a federated reply — one whose parent
 *     Mention never imported, so `parent_post_id` is null — through as a thread
 *     root; the `replies` tab correspondingly lost it. Both directions are
 *     asserted, on one fixture set.
 *  3. **The author feed's sort axis and its cursor axis must be the SAME one.**
 *     A federated post is imported with a remote `created_at` and a
 *     locally-minted id, so id order is not time order. The paging case builds
 *     that disagreement explicitly: the older post carries the LARGER id, so an
 *     id-bounded keyset would skip it forever ("the boost disappears from the
 *     profile feed").
 *  4. **A profile-visibility gate covers EVERY tab.** Post-level `visibility:
 *     public` is not sufficient — a private profile is private on the media tab
 *     too.
 *
 * ## Two things about running against a SHARED database
 *
 * The harness gives the whole run ONE throwaway database, and vitest runs files
 * in parallel, so other suites are writing posts while these cases read. Two
 * consequences, both deliberate:
 *
 *  - Fixtures are stamped fractionally in the FUTURE ({@link HORIZON}). Several
 *    sources below are CAPPED newest-first reads over the entire corpus, and
 *    pinning this suite's rows ahead of every concurrently-written row is what
 *    makes "the capped page is exactly these" a determinate question instead of
 *    a race.
 *  - A corpus-wide read is compared through {@link suiteIdsOf}, which keeps only
 *    the ids this suite created. A naturally-scoped read (one whose predicate
 *    already names this suite's authors, hashtags or topics) is compared through
 *    {@link idsOf} instead, so it also proves NOTHING EXTRA came back.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { bookmarks, posts, userSettings } from '../db/schema';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../db/posts/postRecord';
import {
  followingSource,
  globalDiscoverySource,
  topicSource,
} from '../mtn/feed/engine/sources/forYouSources';
import { videosSource } from '../mtn/feed/engine/sources/discoverySources';
import {
  authoredSource,
  keywordsSource,
  savedSource,
} from '../mtn/feed/engine/sources/userSources';
import { ChronoCursor } from '../mtn/feed/CursorBuilder';
import type { CandidatePost, FeedEngineContext } from '../mtn/feed/engine/types';

let db: Database;
const created: string[] = [];
const settingsOwners: string[] = [];

const VIEWER = 'feedsrc-viewer';
const FOLLOW = 'feedsrc-follow';
const STRANGER = 'feedsrc-stranger';
const AUTHOR = 'feedsrc-author';

/** See the module docblock — every fixture leads the corpus in `created_at`. */
const HORIZON = Date.now() + 60_000;

/** A fixture timestamp, offset from {@link HORIZON} so orderings are explicit. */
function at(offsetMs: number): Date {
  return new Date(HORIZON + offsetMs);
}

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

/** Give `oxyUserId` a profile-visibility setting for the author-feed gate. */
async function setProfileVisibility(
  oxyUserId: string,
  visibility: 'public' | 'private' | 'followers_only',
): Promise<void> {
  settingsOwners.push(oxyUserId);
  await db.insert(userSettings).values({ oxyUserId, privacyProfileVisibility: visibility });
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
  // Child rows (authorships, media, bookmarks) go with the post by cascade.
  if (ids.length > 0) await db.delete(posts).where(inArray(posts.id, ids));
  const owners = settingsOwners.splice(0);
  if (owners.length > 0) await db.delete(userSettings).where(inArray(userSettings.oxyUserId, owners));
});

afterAll(async () => {
  await closePostgres();
});

describe('the following source', () => {
  /**
   * The correlated authorship subquery, asserted on rows.
   *
   * Mutation: break the correlation in `followedAuthorsSql` (compare
   * `post_authorships.post_id` to anything but `posts.id`) and this goes red
   * with an EMPTY result — the exact silent failure it guards.
   */
  it('gathers a followed author\'s public posts, including ones they only collaborated on', async () => {
    const own = await create({ oxyUserId: FOLLOW, createdAt: at(0) });
    const collaborated = await create({
      oxyUserId: STRANGER,
      authorship: [
        { oxyUserId: STRANGER, role: 'owner', status: 'accepted' },
        { oxyUserId: FOLLOW, role: 'collaborator', status: 'accepted' },
      ],
      createdAt: at(-1_000),
    });
    // Each of the following must NOT appear.
    await create({
      oxyUserId: STRANGER,
      authorship: [
        { oxyUserId: STRANGER, role: 'owner', status: 'accepted' },
        // An invitee is not an author until they consent.
        { oxyUserId: FOLLOW, role: 'collaborator', status: 'pending' },
      ],
    });
    await create({ oxyUserId: FOLLOW, visibility: PostVisibility.FOLLOWERS_ONLY });
    await create({ oxyUserId: FOLLOW, type: PostType.BOOST, boostOf: own.id, content: { variants: [] } });
    await create({ oxyUserId: FOLLOW, createdAt: new Date(HORIZON - 30 * 24 * 60 * 60 * 1000) });
    await create({ oxyUserId: STRANGER });

    const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [FOLLOW], seenPostIds: [] };
    // Naturally scoped: the predicate names FOLLOW, so nothing else can match.
    expect(idsOf(await followingSource.gather(ctx, {}, 60))).toEqual([own.id, collaborated.id]);
  });

  it('serves the timeline variant followers-only posts the For You lane withholds', async () => {
    /**
     * The two variants of ONE source differ in exactly this: the ranked For You
     * lane is PUBLIC-only, the chronological Following feed also carries
     * followers-only posts from authors the viewer actually follows (and the
     * viewer's own).
     */
    const followPublic = await create({ oxyUserId: FOLLOW, createdAt: at(0) });
    const followPrivateToFollowers = await create({
      oxyUserId: FOLLOW,
      visibility: PostVisibility.FOLLOWERS_ONLY,
      createdAt: at(-1_000),
    });
    const ownFollowersOnly = await create({
      oxyUserId: VIEWER,
      visibility: PostVisibility.FOLLOWERS_ONLY,
      createdAt: at(-2_000),
    });
    await create({ oxyUserId: STRANGER });

    const ctx: FeedEngineContext = {
      currentUserId: VIEWER,
      followingIds: [FOLLOW],
      subscribedListMemberIds: [],
    };
    expect(idsOf(await followingSource.gather(ctx, { timeline: true }, 31))).toEqual([
      followPublic.id,
      followPrivateToFollowers.id,
      ownFollowersOnly.id,
    ]);
  });

  it('returns nothing for an anonymous viewer', async () => {
    await create({ oxyUserId: FOLLOW });
    expect(await followingSource.gather({ seenPostIds: [] }, {}, 60)).toEqual([]);
  });
});

describe('the topic source', () => {
  /**
   * Regression: "a topic trends but its page shows no posts".
   *
   * `TrendingService` counts a topic from the registry-linked
   * `postClassification.topicRefs` OR the slug-only `postClassification.topics`.
   * The topic feed used to match only the latter, so a post classified with a
   * canonical `topicRefs` entry and no matching slug was counted as trending yet
   * never returned. `topicSlugSql` is a correlated EXISTS over
   * `post_classification_topic_refs` UNION an array containment — both halves
   * are asserted, on posts that carry only ONE of the two encodings.
   */
  it('matches a topic through topicRefs alone and through the slug list alone', async () => {
    const viaRefs = await create({
      createdAt: at(0),
      postClassification: { topics: ['feedsrc-news'], topicRefs: [{ name: 'feedsrc-tech' }] },
    });
    const viaSlug = await create({
      createdAt: at(-1_000),
      postClassification: { topics: ['feedsrc-tech'] },
    });
    await create({ postClassification: { topics: ['feedsrc-sports'], topicRefs: [{ name: 'feedsrc-sports' }] } });
    await create({
      visibility: PostVisibility.FOLLOWERS_ONLY,
      postClassification: { topics: ['feedsrc-tech'] },
    });
    await create({ status: 'draft', postClassification: { topics: ['feedsrc-tech'] } });

    // The slug arrives from a URL segment and is normalized once, in
    // `normalizeTopicSlug` — a mixed-case request must find the stored slugs.
    const gathered = await topicSource.gather({ currentUserId: VIEWER }, { slug: 'FEEDSRC-Tech' }, 31);
    expect(idsOf(gathered)).toEqual([viaRefs.id, viaSlug.id]);
  });
});

describe('the global discovery source', () => {
  /**
   * The discovery lane's QUERY-level safety is the three sensitive FLAGS only.
   * The NSFW-hashtag half is applied in code to the merged pool
   * (`forYouCandidateSources`), so a hashtag-only post is expected HERE and
   * absent THERE — asserting both halves in their own place is what keeps a
   * future "simplification" from collapsing them into one.
   */
  it('excludes every flavour of flagged-sensitive post but not an NSFW hashtag', async () => {
    const clean = await create({ createdAt: at(0) });
    const nsfwTagOnly = await create({ createdAt: at(-1_000), hashtags: ['nsfw'] });
    await create({ postClassification: { sensitive: true } });
    await create({ metadata: { isSensitive: true } });
    await create({
      federation: { activityId: `https://remote.example/notes/${Date.now()}`, sensitive: true },
    });

    const gathered = await globalDiscoverySource.gather(
      { currentUserId: VIEWER, followingIds: [], seenPostIds: [] },
      {},
      20,
    );
    expect(suiteIdsOf(gathered)).toEqual([clean.id, nsfwTagOnly.id]);
  });
});

describe('the videos source', () => {
  /** A post carrying one video media row, with the metadata the filter reads. */
  function videoPost(
    media: { durationSec?: number; orientation?: 'portrait' | 'landscape'; width?: number; height?: number },
    overrides: Partial<PostRecordInput> = {},
  ): Promise<PostRecord> {
    return create({
      type: PostType.VIDEO,
      content: {
        variants: [{ source: 'author', text: 'clip' }],
        media: [{ id: 'feedsrc-media', type: 'video', ...media }],
      },
      ...overrides,
    });
  }

  const PORTRAIT = { durationSec: 30, orientation: 'portrait' as const, width: 1080, height: 1920 };

  it('keeps portrait videos of known-sufficient duration and drops the rest', async () => {
    const portrait = await videoPost(PORTRAIT, { createdAt: at(0) });
    // UNKNOWN IS NOT A VALUE: `durationSec` is absent on ~94% of production
    // video items, so the duration rule applies when known and ABSTAINS when
    // not. A plain `>=` here discarded the corpus rather than enforcing a policy.
    const unknownDuration = await videoPost(
      { orientation: 'portrait', width: 1080, height: 1920 },
      { createdAt: at(-1_000) },
    );
    const seen = await videoPost(PORTRAIT);
    await videoPost({ ...PORTRAIT, orientation: 'landscape' });
    await videoPost({ ...PORTRAIT, durationSec: 5 });
    // No persisted dimensions — `width > 0` is NULL, which excludes the row.
    await videoPost({ durationSec: 30, orientation: 'portrait' });
    await videoPost(PORTRAIT, { postClassification: { sensitive: true } });
    await videoPost(PORTRAIT, { visibility: PostVisibility.FOLLOWERS_ONLY });
    await create({
      type: PostType.IMAGE,
      content: {
        variants: [{ source: 'author', text: 'pic' }],
        media: [{ id: 'feedsrc-img', type: 'image', width: 800, height: 600, orientation: 'portrait' }],
      },
    });

    const gathered = await videosSource.gather(
      { currentUserId: VIEWER, seenPostIds: [seen.id] },
      {},
      500,
    );
    expect(suiteIdsOf(gathered)).toEqual([portrait.id, unknownDuration.id]);
  });

  it('honours the orientation and duration filters the client can send', async () => {
    const portrait = await videoPost(PORTRAIT, { createdAt: at(0) });
    const landscape = await videoPost({ ...PORTRAIT, orientation: 'landscape' }, { createdAt: at(-1_000) });
    const short = await videoPost({ ...PORTRAIT, durationSec: 5 }, { createdAt: at(-2_000) });

    const everyOrientation = await videosSource.gather(
      { currentUserId: VIEWER, seenPostIds: [], videoFilters: { orientation: 'all' } },
      {},
      500,
    );
    expect(suiteIdsOf(everyOrientation)).toEqual([portrait.id, landscape.id]);

    const shortAllowed = await videosSource.gather(
      { currentUserId: VIEWER, seenPostIds: [], videoFilters: { minDurationSec: 3 } },
      {},
      500,
    );
    expect(suiteIdsOf(shortAllowed)).toEqual([portrait.id, short.id]);
  });
});

describe('the keywords source', () => {
  it('matches a hashtag case-insensitively against the stored canonical array', async () => {
    const tagged = await create({ createdAt: at(0), hashtags: ['feedsrccats'] });
    await create({ hashtags: ['feedsrcdogs'] });
    await create({ hashtags: [] });

    // The caller's tag is lowercased; the stored array is already canonical.
    const gathered = await keywordsSource.gather({}, { hashtags: ['FeedsrcCats'] }, 31);
    expect(idsOf(gathered)).toEqual([tagged.id]);
  });

  /**
   * The body lives in `post_content_variants`, so a keyword match is a
   * correlated EXISTS over that child table — the same shape as the authorship
   * subquery and the same silent failure if the correlation is lost.
   */
  it('matches a keyword in ANY rendition\'s body, or in the hashtag array', async () => {
    const inPrimaryBody = await create({
      createdAt: at(0),
      content: { variants: [{ source: 'author', tag: 'en', text: 'about feedsrcwidgets today' }] },
    });
    const inTranslation = await create({
      createdAt: at(-1_000),
      content: {
        variants: [
          { source: 'author', tag: 'en', text: 'nothing to see' },
          { source: 'machine', tag: 'es', text: 'sobre feedsrcwidgets hoy' },
        ],
      },
    });
    const inHashtags = await create({ createdAt: at(-2_000), hashtags: ['feedsrcwidgets'] });
    await create({ content: { variants: [{ source: 'author', text: 'unrelated' }] } });

    const gathered = await keywordsSource.gather({}, { keywords: ['FeedsrcWidgets'] }, 31);
    expect(idsOf(gathered)).toEqual([inPrimaryBody.id, inTranslation.id, inHashtags.id]);
  });

  it('returns nothing when given neither hashtags nor keywords', async () => {
    await create({ hashtags: ['feedsrccats'] });
    expect(await keywordsSource.gather({}, {}, 31)).toEqual([]);
  });
});

describe('the authored source (the profile feed)', () => {
  /**
   * THE reply-classification regression, asserted in BOTH directions on one
   * fixture set.
   *
   * A federated reply arrives with `federation.inReplyTo` set and no
   * `parent_post_id` (Mention never imported the parent). Reading "is a root" as
   * `parent_post_id IS NULL` promoted it onto the profile's main tab AND lost it
   * from the replies tab. The stored `is_reply` answers for both encodings, so
   * both tabs are checked against the same posts.
   */
  it('splits roots from replies under both parent encodings', async () => {
    const root = await create({ oxyUserId: AUTHOR, createdAt: at(0) });
    const nativeReply = await create({
      oxyUserId: AUTHOR,
      createdAt: at(-1_000),
      parentPostId: root.id,
    });
    const federatedReply = await create({
      oxyUserId: AUTHOR,
      createdAt: at(-2_000),
      parentPostId: null,
      federation: {
        activityId: `https://remote.example/notes/feedsrc-${Date.now()}`,
        inReplyTo: 'https://remote.example/notes/parent',
      },
    });

    const rootTab = await authoredSource.gather(
      { currentUserId: VIEWER },
      { authorId: AUTHOR, filter: 'posts' },
      31,
    );
    expect(idsOf(rootTab)).toEqual([root.id]);

    const replyTab = await authoredSource.gather(
      { currentUserId: VIEWER },
      { authorId: AUTHOR, filter: 'replies' },
      31,
    );
    expect(idsOf(replyTab)).toEqual([nativeReply.id, federatedReply.id]);
  });

  it('serves the author\'s boosts on the boosts tab and on the main tab', async () => {
    // A boost is a top-level post, so it belongs on both — which is why the
    // `author` definition hydrates at depth 1 (a boost's own body is empty).
    const original = await create({ oxyUserId: STRANGER });
    const boost = await create({
      oxyUserId: AUTHOR,
      createdAt: at(0),
      type: PostType.BOOST,
      boostOf: original.id,
      content: { variants: [] },
    });
    const plain = await create({ oxyUserId: AUTHOR, createdAt: at(-1_000) });

    const boostTab = await authoredSource.gather(
      { currentUserId: VIEWER },
      { authorId: AUTHOR, filter: 'boosts' },
      31,
    );
    expect(idsOf(boostTab)).toEqual([boost.id]);

    const mainTab = await authoredSource.gather(
      { currentUserId: VIEWER },
      { authorId: AUTHOR, filter: 'posts' },
      31,
    );
    expect(idsOf(mainTab)).toEqual([boost.id, plain.id]);
  });

  it('accepts all three media shapes on the media tab, and no boost or reply', async () => {
    const typedMedia = await create({ oxyUserId: AUTHOR, createdAt: at(0), type: PostType.IMAGE });
    const withMediaRow = await create({
      oxyUserId: AUTHOR,
      createdAt: at(-1_000),
      content: {
        variants: [{ source: 'author', text: 'pic' }],
        media: [{ id: 'feedsrc-media', type: 'image', width: 10, height: 10 }],
      },
    });
    const withAttachment = await create({
      oxyUserId: AUTHOR,
      createdAt: at(-2_000),
      content: {
        variants: [{ source: 'author', text: 'pic' }],
        attachments: [{ type: 'media', id: 'feedsrc-media', mediaType: 'image' }],
      },
    });
    await create({ oxyUserId: AUTHOR, createdAt: at(-3_000) });
    await create({
      oxyUserId: AUTHOR,
      type: PostType.IMAGE,
      parentPostId: typedMedia.id,
    });
    await create({
      oxyUserId: AUTHOR,
      type: PostType.BOOST,
      boostOf: typedMedia.id,
      content: { variants: [] },
    });

    const gathered = await authoredSource.gather(
      { currentUserId: VIEWER },
      { authorId: AUTHOR, filter: 'media' },
      31,
    );
    expect(idsOf(gathered)).toEqual([typedMedia.id, withMediaRow.id, withAttachment.id]);
  });

  /**
   * The profile VIDEOS tab is deliberately narrower than the media tab and wider
   * than the global videos feed.
   *
   * Narrower than `media`: only the two shapes `videoOnlyFilter.keep`
   * recognizes, with no attachment branch — an attachment-only post would be
   * fetched and then dropped by the filter, paying for a page that arrives
   * short. Wider than `FeedQueryBuilder.buildVideosQuery`, which additionally
   * gates on duration and orientation: a profile grid shows the author's videos,
   * not a reel lane's selection of them, so a two-second landscape clip belongs
   * here and not there.
   */
  it('keeps both video shapes on the videos tab, and no attachment, reply or boost', async () => {
    const typedVideo = await create({ oxyUserId: AUTHOR, createdAt: at(0), type: PostType.VIDEO });
    const withVideoRow = await create({
      oxyUserId: AUTHOR,
      createdAt: at(-1_000),
      content: {
        variants: [{ source: 'author', text: 'clip' }],
        // Short and landscape on purpose: the reel lane would reject both, and
        // the profile grid must not.
        media: [{ id: 'feedsrc-video', type: 'video', width: 40, height: 20, durationSec: 2 }],
      },
    });
    await create({
      oxyUserId: AUTHOR,
      createdAt: at(-2_000),
      content: {
        variants: [{ source: 'author', text: 'clip' }],
        attachments: [{ type: 'media', id: 'feedsrc-video', mediaType: 'video' }],
      },
    });
    await create({ oxyUserId: AUTHOR, createdAt: at(-3_000), type: PostType.IMAGE });
    await create({
      oxyUserId: AUTHOR,
      type: PostType.VIDEO,
      parentPostId: typedVideo.id,
    });
    await create({
      oxyUserId: AUTHOR,
      type: PostType.BOOST,
      boostOf: typedVideo.id,
      content: { variants: [] },
    });

    const gathered = await authoredSource.gather(
      { currentUserId: VIEWER },
      { authorId: AUTHOR, filter: 'videos' },
      31,
    );
    expect(idsOf(gathered)).toEqual([typedVideo.id, withVideoRow.id]);
  });

  it('degrades an unrecognized filter to the posts tab rather than erroring', async () => {
    const root = await create({ oxyUserId: AUTHOR, createdAt: at(0) });
    await create({ oxyUserId: AUTHOR, parentPostId: root.id });

    const gathered = await authoredSource.gather(
      { currentUserId: VIEWER },
      { authorId: AUTHOR, filter: 'bogus' },
      31,
    );
    expect(idsOf(gathered)).toEqual([root.id]);
  });

  /**
   * Regression: "a boost disappears from the profile feed".
   *
   * A federated post is imported with the REMOTE `created_at` and a
   * locally-minted id, so an OLD post routinely carries a LARGE id. The fixture
   * makes that explicit — the older post's id sorts ABOVE the newer one's — so
   * an id-bounded keyset behind a `created_at` sort drops it on the page
   * boundary and can never bring it back.
   *
   * Mutation: page on `posts.id` instead of `created_at` in `chronoCursorSql`
   * and the second page comes back EMPTY.
   */
  it('sorts and pages on created_at even when the id order disagrees', async () => {
    const newer = await create({
      oxyUserId: AUTHOR,
      id: '000000000000000000000001',
      createdAt: at(0),
    });
    const older = await create({
      oxyUserId: AUTHOR,
      id: 'ffffffffffffffffffffffff',
      createdAt: at(-60_000),
    });

    const firstPage = await authoredSource.gather(
      { currentUserId: VIEWER },
      { authorId: AUTHOR, filter: 'posts' },
      31,
    );
    expect(idsOf(firstPage)).toEqual([newer.id, older.id]);

    const secondPage = await authoredSource.gather(
      { currentUserId: VIEWER, cursor: ChronoCursor.build(newer.id, newer.createdAt) },
      { authorId: AUTHOR, filter: 'posts' },
      31,
    );
    expect(idsOf(secondPage)).toEqual([older.id]);
  });

  describe('the profile-visibility gate', () => {
    it('withholds a private profile from a non-follower on every tab', async () => {
      await setProfileVisibility(AUTHOR, 'private');
      await create({ oxyUserId: AUTHOR, type: PostType.IMAGE });

      const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [STRANGER] };
      expect(await authoredSource.gather(ctx, { authorId: AUTHOR, filter: 'posts' }, 31)).toEqual([]);
      // The media tab is gated too — the posts are `visibility: public`, so
      // post-level visibility alone would have served them.
      expect(await authoredSource.gather(ctx, { authorId: AUTHOR, filter: 'media' }, 31)).toEqual([]);
    });

    it('withholds a followers-only profile from an anonymous viewer', async () => {
      await setProfileVisibility(AUTHOR, 'followers_only');
      await create({ oxyUserId: AUTHOR });
      expect(await authoredSource.gather({}, { authorId: AUTHOR, filter: 'posts' }, 31)).toEqual([]);
    });

    it('serves a private profile to a follower and to its owner', async () => {
      await setProfileVisibility(AUTHOR, 'private');
      const post = await create({ oxyUserId: AUTHOR, createdAt: at(0) });

      const follower = await authoredSource.gather(
        { currentUserId: VIEWER, followingIds: [AUTHOR] },
        { authorId: AUTHOR, filter: 'posts' },
        31,
      );
      expect(idsOf(follower)).toEqual([post.id]);

      const owner = await authoredSource.gather(
        { currentUserId: AUTHOR },
        { authorId: AUTHOR, filter: 'posts' },
        31,
      );
      expect(idsOf(owner)).toEqual([post.id]);
    });
  });
});

describe('the saved source', () => {
  /** Bookmark `postId` for `VIEWER`, with an explicit instant so order is stated. */
  async function bookmark(postId: string, createdAt: Date): Promise<void> {
    await db.insert(bookmarks).values({ userId: VIEWER, postId, createdAt });
  }

  /**
   * The saved feed pages over the RELATIONSHIP, not the post: its order is the
   * bookmark's `(created_at, id)`. The Mongo original filtered `_id < cursor`
   * while sorting by `createdAt` — two different axes, which only appeared to
   * work because an ObjectId encodes creation time. Neither half survives, so
   * this asserts the whole two-page walk.
   */
  it('returns bookmarks newest-first and continues from the cursor it stamped', async () => {
    const first = await create({ createdAt: at(-3_000) });
    const second = await create({ createdAt: at(-2_000) });
    const third = await create({ createdAt: at(-1_000) });
    await bookmark(first.id, at(-3_000));
    await bookmark(second.id, at(-2_000));
    await bookmark(third.id, at(-1_000));

    const pageOne = await savedSource.gather({ currentUserId: VIEWER, pageLimit: 2 }, {}, 3);
    expect(idsOf(pageOne)).toEqual([third.id, second.id]);

    // The last item of a page carries the token that continues it.
    const cursor = pageOne[pageOne.length - 1]._feedCursor;
    expect(cursor).toBeTruthy();

    const pageTwo = await savedSource.gather(
      { currentUserId: VIEWER, pageLimit: 2, cursor },
      {},
      3,
    );
    expect(idsOf(pageTwo)).toEqual([first.id]);
    // The last page has no more to give, so it stamps no cursor.
    expect(pageTwo[0]._feedCursor).toBeUndefined();
  });

  it('drops a bookmark whose post is no longer published', async () => {
    const published = await create({ createdAt: at(-1_000) });
    const draft = await create({ createdAt: at(-2_000), status: 'draft' });
    await bookmark(published.id, at(-1_000));
    await bookmark(draft.id, at(-2_000));

    const gathered = await savedSource.gather({ currentUserId: VIEWER, pageLimit: 30 }, {}, 31);
    expect(idsOf(gathered)).toEqual([published.id]);
  });

  it('returns nothing for an anonymous viewer', async () => {
    const post = await create();
    await bookmark(post.id, at(0));
    expect(await savedSource.gather({ pageLimit: 30 }, {}, 31)).toEqual([]);
  });
});

describe('a deleted bookmark anchor', () => {
  it('does not resurrect its post', async () => {
    // A guard against the cascade being weakened: `bookmarks.post_id` is
    // `ON DELETE CASCADE`, so deleting the post must take the bookmark with it
    // rather than leaving the saved feed pointing at a row it can never load.
    const post = await create();
    await db.insert(bookmarks).values({ userId: VIEWER, postId: post.id, createdAt: at(0) });
    await db.delete(posts).where(eq(posts.id, post.id));

    const remaining = await db
      .select({ id: bookmarks.id })
      .from(bookmarks)
      .where(eq(bookmarks.postId, post.id));
    expect(remaining).toEqual([]);
  });
});
