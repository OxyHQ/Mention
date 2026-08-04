/**
 * The social-graph SOURCE modules, against a real database.
 *
 * The suite this replaces mocked `Post`/`Like`/`EntityFollow`/`StarterPack` and
 * asserted the KEYS of each query object. Nothing here can be checked that way
 * any more, and it never proved much: three of these sources reach a CHILD table
 * through a correlated subquery or a junction, which is the shape that compiles,
 * runs, matches NOTHING and raises nothing.
 *
 * What each case is actually guarding:
 *
 *  - **`mentionsOfMe` is a correlated `EXISTS` over `post_mentions`.** Mongo
 *    matched an array element (`{ mentions: viewerId }`); the port must correlate
 *    `post_mentions.post_id` to `posts.id`. Lose that and the mentions feed is
 *    silently empty, so the case asserts a NON-EMPTY exact set.
 *  - **Starter-pack and list members are JUNCTION TABLES, not embedded id
 *    arrays.** Reading the pack row (as Mongo did) returns no members at all, so
 *    the case builds real member rows and asserts their posts come back.
 *  - **A reply is the stored `is_reply`, in both encodings.** The mirror image of
 *    the profile-feed case in `feedSources.test.ts`: `repliesFromFollows` must
 *    pick up a FEDERATED reply whose parent Mention never imported, which has no
 *    `parent_post_id` at all.
 *  - **A followed hashtag is stored ALREADY CANONICAL and must be queried
 *    verbatim.** The fixtures are deliberately NOT canonical — a canonical tag is
 *    a fixpoint of every normalization, so feeding one in cannot tell "passes
 *    through" apart from "normalizes again". Only a value a second normalization
 *    WOULD change can observe the absence of that step.
 *  - **`friendsEngaged` folds two different engagement records into one count.**
 *    Real `likes` rows and real boost posts, with the resulting order asserted.
 *
 * Fixtures are stamped fractionally in the FUTURE and corpus-wide reads are
 * compared through {@link suiteIdsOf}: the harness gives the whole run ONE
 * throwaway database and vitest runs files in parallel, so a capped
 * newest-first read over the whole corpus is otherwise a race. A naturally
 * scoped read — one whose predicate already names this suite's authors, tags or
 * pack — is compared through {@link idsOf}, which also proves nothing extra came
 * back.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import {
  entityFollows,
  likes,
  posts,
  starterPackMembers,
  starterPacks,
} from '../db/schema';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../db/posts/postRecord';
import { mutualsSource } from '../mtn/feed/engine/sources/userSources';
import {
  boostsFromFollowsSource,
  friendsEngagedSource,
  friendsOfFriendsSource,
  hashtagFollowsSource,
  mentionsOfMeSource,
  onThisDaySource,
  quotesSource,
  repliesFromFollowsSource,
  starterPackSource,
} from '../mtn/feed/engine/sources/socialSources';
import type { CandidatePost, FeedEngineContext } from '../mtn/feed/engine/types';

let db: Database;
const created: string[] = [];
const createdPacks: string[] = [];
const followedTagOwners: string[] = [];

const VIEWER = 'socialsrc-viewer';
const FRIEND_A = 'socialsrc-friend-a';
const FRIEND_B = 'socialsrc-friend-b';
const AUTHOR = 'socialsrc-author';
const STRANGER = 'socialsrc-stranger';

/** See the module docblock — every fixture leads the corpus in `created_at`. */
const HORIZON = Date.now() + 60_000;

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
  // Likes, mentions and authorships go with the post by cascade; pack members
  // go with the pack.
  if (ids.length > 0) await db.delete(posts).where(inArray(posts.id, ids));
  const packs = createdPacks.splice(0);
  if (packs.length > 0) await db.delete(starterPacks).where(inArray(starterPacks.id, packs));
  const followers = followedTagOwners.splice(0);
  if (followers.length > 0) {
    await db.delete(entityFollows).where(inArray(entityFollows.userId, followers));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the mutuals source', () => {
  it('serves a mutual\'s followers-only posts, which are not public to anyone else', async () => {
    // A mutual is by definition a follower, so followers-only is in scope —
    // that is the whole difference from `friendsOfFriends` below.
    const publicPost = await create({ oxyUserId: FRIEND_A, createdAt: at(0) });
    const followersOnly = await create({
      oxyUserId: FRIEND_B,
      visibility: PostVisibility.FOLLOWERS_ONLY,
      createdAt: at(-1_000),
    });
    await create({ oxyUserId: FRIEND_A, visibility: PostVisibility.PRIVATE });
    await create({ oxyUserId: FRIEND_A, status: 'draft' });
    await create({ oxyUserId: STRANGER });

    const ctx: FeedEngineContext = { currentUserId: VIEWER, mutualIds: [FRIEND_A, FRIEND_B] };
    expect(idsOf(await mutualsSource.gather(ctx, {}, 30))).toEqual([publicPost.id, followersOnly.id]);
  });

  it('returns nothing when the controller populated no mutual ids', async () => {
    await create({ oxyUserId: FRIEND_A });
    expect(await mutualsSource.gather({ currentUserId: VIEWER }, {}, 30)).toEqual([]);
  });
});

describe('the friendsEngaged source', () => {
  /** `FRIEND` up-voted `postId` inside the recency window. */
  async function like(userId: string, postId: string): Promise<void> {
    await db.insert(likes).values({ userId, postId, value: 1, createdAt: at(-1_000) });
  }

  it('ranks a post by how many follows engaged with it', async () => {
    const twoFriends = await create({ createdAt: at(-1_000) });
    const oneFriend = await create({ createdAt: at(-2_000) });
    const noFriends = await create({ createdAt: at(-3_000) });
    await like(FRIEND_A, twoFriends.id);
    await like(FRIEND_B, twoFriends.id);
    await like(FRIEND_A, oneFriend.id);
    // A stranger's like is not a friend's, and must not pull the post in.
    await like(STRANGER, noFriends.id);
    // A down-vote is not engagement.
    await db.insert(likes).values({ userId: FRIEND_B, postId: noFriends.id, value: -1, createdAt: at(-1_000) });

    const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [FRIEND_A, FRIEND_B] };
    const gathered = await friendsEngagedSource.gather(ctx, {}, 30);

    expect(idsOf(gathered)).toEqual([twoFriends.id, oneFriend.id]);
    expect(gathered[0].finalScore).toBe(2);
    expect(gathered[1].finalScore).toBe(1);
  });

  it('counts a friend\'s BOOST alongside their like, on the boosted original', async () => {
    const original = await create({ createdAt: at(-1_000) });
    await create({
      oxyUserId: FRIEND_A,
      type: PostType.BOOST,
      boostOf: original.id,
      content: { variants: [] },
      createdAt: at(-500),
    });
    await like(FRIEND_B, original.id);

    const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [FRIEND_A, FRIEND_B] };
    const gathered = await friendsEngagedSource.gather(ctx, {}, 30);

    // The BOOST post itself never appears — it has an empty body, and the
    // original is what carries the content.
    expect(idsOf(gathered)).toEqual([original.id]);
    expect(gathered[0].finalScore).toBe(2);
  });

  it('withholds the viewer\'s own post however many friends engaged with it', async () => {
    const mine = await create({ oxyUserId: VIEWER, createdAt: at(-1_000) });
    const theirs = await create({ oxyUserId: AUTHOR, createdAt: at(-2_000) });
    await like(FRIEND_A, mine.id);
    await like(FRIEND_A, theirs.id);

    const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [FRIEND_A] };
    expect(idsOf(await friendsEngagedSource.gather(ctx, {}, 30))).toEqual([theirs.id]);
  });

  it('keeps an author-less post, which a bare `<>` would drop', async () => {
    /**
     * `posts.oxy_user_id` is nullable (the raw federated batch-insert path can
     * omit it) and `NULL <> 'viewer'` is NULL, which excludes the row. The
     * exclusion is written as `oxy_user_id IS NULL OR oxy_user_id <> viewer` for
     * exactly this, and this is the fixture that can tell the two apart.
     */
    const authorless = await create({ oxyUserId: null, createdAt: at(-1_000) });
    await like(FRIEND_A, authorless.id);

    const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [FRIEND_A] };
    expect(idsOf(await friendsEngagedSource.gather(ctx, {}, 30))).toEqual([authorless.id]);
  });

  it('returns nothing when the viewer follows nobody', async () => {
    const post = await create();
    await like(FRIEND_A, post.id);
    expect(await friendsEngagedSource.gather({ currentUserId: VIEWER, followingIds: [] }, {}, 30)).toEqual([]);
  });
});

describe('the quotes source', () => {
  it('finds the quotes OF a post', async () => {
    const subject = await create({ createdAt: at(-5_000) });
    const other = await create({ createdAt: at(-5_000) });
    const quote = await create({
      createdAt: at(0),
      type: PostType.QUOTE,
      quoteOf: subject.id,
    });
    await create({ type: PostType.QUOTE, quoteOf: other.id });
    // A boost is not a quote — it has no body of its own.
    await create({ type: PostType.BOOST, boostOf: subject.id, content: { variants: [] } });

    expect(idsOf(await quotesSource.gather({}, { postId: subject.id }, 30))).toEqual([quote.id]);
  });

  it('finds the quotes BY a set of authors', async () => {
    const subject = await create({ createdAt: at(-5_000) });
    const byAuthor = await create({
      oxyUserId: AUTHOR,
      createdAt: at(0),
      type: PostType.QUOTE,
      quoteOf: subject.id,
    });
    // Same author, but not a quote.
    await create({ oxyUserId: AUTHOR });
    // A quote, but by somebody else.
    await create({ oxyUserId: STRANGER, type: PostType.QUOTE, quoteOf: subject.id });

    expect(idsOf(await quotesSource.gather({}, { authorIds: [AUTHOR] }, 30))).toEqual([byAuthor.id]);
  });

  it('returns nothing with neither a post nor an author to anchor on', async () => {
    const subject = await create();
    await create({ type: PostType.QUOTE, quoteOf: subject.id });
    expect(await quotesSource.gather({}, {}, 30)).toEqual([]);
  });
});

describe('the repliesFromFollows source', () => {
  /**
   * The mirror image of the profile-feed reply case.
   *
   * A federated reply arrives with `federation.inReplyTo` and NO
   * `parent_post_id`, because Mention never imported the parent. Selecting
   * replies as `parent_post_id IS NOT NULL` loses it from the conversation feed
   * — the same misclassification that promoted it onto the profile's main tab.
   */
  it('selects a follow\'s replies under both parent encodings', async () => {
    const root = await create({ oxyUserId: FRIEND_A, createdAt: at(-5_000) });
    const nativeReply = await create({
      oxyUserId: FRIEND_A,
      createdAt: at(0),
      parentPostId: root.id,
    });
    const federatedReply = await create({
      oxyUserId: FRIEND_A,
      createdAt: at(-1_000),
      federation: {
        activityId: `https://remote.example/notes/socialsrc-${Date.now()}`,
        inReplyTo: 'https://remote.example/notes/parent',
      },
    });
    // Someone the viewer does not follow.
    await create({ oxyUserId: STRANGER, parentPostId: root.id });
    // A follow's reply that is not public.
    await create({
      oxyUserId: FRIEND_A,
      parentPostId: root.id,
      visibility: PostVisibility.FOLLOWERS_ONLY,
    });

    const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [FRIEND_A] };
    expect(idsOf(await repliesFromFollowsSource.gather(ctx, {}, 30))).toEqual([
      nativeReply.id,
      federatedReply.id,
    ]);
  });

  it('returns nothing when the viewer follows nobody', async () => {
    const root = await create({ oxyUserId: FRIEND_A });
    await create({ oxyUserId: FRIEND_A, parentPostId: root.id });
    expect(await repliesFromFollowsSource.gather({ currentUserId: VIEWER, followingIds: [] }, {}, 30)).toEqual([]);
  });
});

describe('the boostsFromFollows source', () => {
  it('selects only the follows\' boost posts', async () => {
    const original = await create({ oxyUserId: STRANGER, createdAt: at(-5_000) });
    const boost = await create({
      oxyUserId: FRIEND_A,
      createdAt: at(0),
      type: PostType.BOOST,
      boostOf: original.id,
      content: { variants: [] },
    });
    await create({ oxyUserId: FRIEND_A });
    await create({
      oxyUserId: STRANGER,
      type: PostType.BOOST,
      boostOf: original.id,
      content: { variants: [] },
    });

    const ctx: FeedEngineContext = { currentUserId: VIEWER, followingIds: [FRIEND_A] };
    expect(idsOf(await boostsFromFollowsSource.gather(ctx, {}, 30))).toEqual([boost.id]);
  });
});

describe('the mentionsOfMe source', () => {
  /**
   * THE correlated-subquery case of this file.
   *
   * `mentions` became a junction table, so Mongo's array-element match becomes
   * `exists (select 1 from post_mentions where post_id = posts.id and
   * oxy_user_id = $viewer)`. Render either side of that correlation BARE and it
   * compares two columns of `post_mentions` to each other — the mentions feed
   * goes empty with no error at all.
   *
   * Mutation: drop the `post_mentions.post_id = posts.id` term and this goes red
   * by returning the OTHER post too; break the correlation and it goes red by
   * returning nothing.
   */
  it('matches a post that mentions the viewer, and no other', async () => {
    const mentionsMe = await create({ createdAt: at(0), mentions: [VIEWER, STRANGER] });
    const mentionsSomeoneElse = await create({ createdAt: at(-1_000), mentions: [STRANGER] });
    const mentionsNobody = await create({ createdAt: at(-2_000) });
    const followersOnly = await create({
      createdAt: at(-3_000),
      mentions: [VIEWER],
      visibility: PostVisibility.FOLLOWERS_ONLY,
    });
    await create({ mentions: [VIEWER], visibility: PostVisibility.PRIVATE });

    const gathered = await mentionsOfMeSource.gather({ currentUserId: VIEWER }, {}, 30);
    // A mention is an invitation to read, so followers-only is in scope.
    expect(suiteIdsOf(gathered)).toEqual([mentionsMe.id, followersOnly.id]);
    expect(suiteIdsOf(gathered)).not.toContain(mentionsSomeoneElse.id);
    expect(suiteIdsOf(gathered)).not.toContain(mentionsNobody.id);
  });

  it('returns nothing for an anonymous viewer', async () => {
    await create({ mentions: [VIEWER] });
    expect(await mentionsOfMeSource.gather({}, {}, 30)).toEqual([]);
  });
});

describe('the hashtagFollows source', () => {
  /** The viewer follows `tag` — stored exactly as `POST /entity-follows` left it. */
  async function follow(tag: string): Promise<void> {
    followedTagOwners.push(VIEWER);
    await db.insert(entityFollows).values({ userId: VIEWER, entityType: 'hashtag', entityId: tag });
  }

  /**
   * `POST /entity-follows` canonicalizes a followed tag with the SAME
   * `normalizeHashtag` that derives `posts.hashtags`, so the two are one string
   * by construction and this source must pass it through UNTOUCHED. It used to
   * lowercase again — a second rule, free to drift from the first, and it never
   * matched the punctuation-stripping half of the canonical form.
   *
   * The fixtures are deliberately non-canonical, which is the only way to
   * observe the ABSENCE of a second normalization: a canonical tag is a fixpoint
   * of every normalization, so the assertion would hold either way.
   */
  it('queries a followed tag verbatim rather than re-normalizing it', async () => {
    await follow('socialsrcCats');
    await follow('socialsrc-dogs');
    const mixedCase = await create({ createdAt: at(0), hashtags: ['socialsrcCats'] });
    const punctuated = await create({ createdAt: at(-1_000), hashtags: ['socialsrc-dogs'] });
    // What a re-lowercasing / re-stripping pass would have gone looking for.
    await create({ hashtags: ['socialsrccats'] });
    await create({ hashtags: ['socialsrcdogs'] });
    await create({ hashtags: ['socialsrcbirds'] });

    const gathered = await hashtagFollowsSource.gather({ currentUserId: VIEWER }, {}, 30);
    expect(idsOf(gathered)).toEqual([mixedCase.id, punctuated.id]);
  });

  it('returns nothing when the viewer follows no hashtags', async () => {
    await create({ hashtags: ['socialsrccats'] });
    expect(await hashtagFollowsSource.gather({ currentUserId: VIEWER }, {}, 30)).toEqual([]);
  });
});

describe('the starterPack source', () => {
  /**
   * Members are a JUNCTION TABLE, not the embedded `memberOxyUserIds` array
   * Mongo held. Reading the pack row — the literal translation — returns no
   * members at all and therefore an empty feed, so this builds real member rows.
   */
  it('resolves members from the junction table and serves their posts', async () => {
    const [pack] = await db
      .insert(starterPacks)
      .values({ ownerOxyUserId: AUTHOR, name: 'socialsrc pack' })
      .returning({ id: starterPacks.id });
    createdPacks.push(pack.id);
    await db.insert(starterPackMembers).values([
      { packId: pack.id, oxyUserId: FRIEND_A, position: 0 },
      { packId: pack.id, oxyUserId: FRIEND_B, position: 1 },
    ]);

    const first = await create({ oxyUserId: FRIEND_A, createdAt: at(0) });
    const second = await create({ oxyUserId: FRIEND_B, createdAt: at(-1_000) });
    await create({ oxyUserId: STRANGER });
    await create({ oxyUserId: FRIEND_A, visibility: PostVisibility.FOLLOWERS_ONLY });

    const gathered = await starterPackSource.gather({}, { packId: pack.id }, 30);
    expect(idsOf(gathered)).toEqual([first.id, second.id]);
  });

  it('returns nothing for a pack id that names no pack', async () => {
    // The Mongo original guarded this with `ObjectId.isValid`; that guard is
    // deleted, and a text id naming no row already produces the same answer.
    await create({ oxyUserId: FRIEND_A });
    expect(await starterPackSource.gather({}, { packId: 'socialsrc-no-such-pack' }, 30)).toEqual([]);
    expect(await starterPackSource.gather({}, {}, 30)).toEqual([]);
  });

  it('returns nothing for a pack with no members', async () => {
    const [pack] = await db
      .insert(starterPacks)
      .values({ ownerOxyUserId: AUTHOR, name: 'socialsrc empty pack' })
      .returning({ id: starterPacks.id });
    createdPacks.push(pack.id);
    await create({ oxyUserId: FRIEND_A });

    expect(await starterPackSource.gather({}, { packId: pack.id }, 30)).toEqual([]);
  });
});

describe('the onThisDay source', () => {
  /**
   * The anchor is this UTC month/day in the year 2000 — a LEAP year, so the
   * fixture still exists when the suite runs on 29 February. Deriving it as
   * "last year" instead makes the suite fail one day in four with an
   * off-by-one-day that looks like a query bug.
   *
   * Derived INSIDE each case, not once at module scope, and the difference is a
   * real flake rather than style. `onThisDaySource.gather` reads `new Date()` at
   * CALL time; a module-scope anchor is read when the file is first evaluated.
   * If the UTC day rolls over between the two, the fixture's month/day and the
   * query's disagree, the source correctly returns nothing, and both cases below
   * go red together looking like a broken predicate. The window is a few seconds
   * a day — undemonstrable, which is exactly why it is worth closing rather than
   * waiting to observe. This narrows it to the microseconds between the anchor
   * and the query; closing it entirely would need the source to take an injected
   * clock, which is a production change this does not justify.
   */
  function anchor(): { anniversary: Date; dayBefore: Date } {
    const now = new Date();
    const anniversary = new Date(Date.UTC(2000, now.getUTCMonth(), now.getUTCDate(), 12));
    return {
      anniversary,
      dayBefore: new Date(anniversary.getTime() - 24 * 60 * 60 * 1000),
    };
  }

  it('matches the viewer\'s own posts from an earlier year on today\'s month and day', async () => {
    const { anniversary, dayBefore } = anchor();
    const memory = await create({ oxyUserId: VIEWER, createdAt: anniversary });
    // Right day, wrong year — today is not nostalgia.
    await create({ oxyUserId: VIEWER, createdAt: at(0) });
    // Right year, wrong day.
    await create({ oxyUserId: VIEWER, createdAt: dayBefore });
    // Right day, wrong person.
    await create({ oxyUserId: STRANGER, createdAt: anniversary });

    const gathered = await onThisDaySource.gather({ currentUserId: VIEWER }, {}, 30);
    expect(suiteIdsOf(gathered)).toEqual([memory.id]);
  });

  it('widens to the viewer plus their follows on the follows scope', async () => {
    const { anniversary } = anchor();
    const mine = await create({ oxyUserId: VIEWER, createdAt: anniversary });
    const friends = await create({
      oxyUserId: FRIEND_A,
      createdAt: new Date(anniversary.getTime() - 1_000),
    });
    await create({ oxyUserId: STRANGER, createdAt: anniversary });

    const gathered = await onThisDaySource.gather(
      { currentUserId: VIEWER, followingIds: [FRIEND_A] },
      { scope: 'follows' },
      30,
    );
    expect(suiteIdsOf(gathered)).toEqual([mine.id, friends.id]);
  });

  it('returns nothing for an anonymous viewer', async () => {
    await create({ oxyUserId: VIEWER, createdAt: anchor().anniversary });
    expect(await onThisDaySource.gather({}, {}, 30)).toEqual([]);
  });
});

describe('the friendsOfFriends source', () => {
  it('serves a friend-of-a-friend\'s PUBLIC posts only', async () => {
    // A friend-of-a-friend is NOT one of the viewer's followers, so their
    // followers-only posts are out of scope — the one way this differs from
    // `mutuals`, asserted on the same fixture shape.
    const publicPost = await create({ oxyUserId: FRIEND_A, createdAt: at(0) });
    await create({ oxyUserId: FRIEND_A, visibility: PostVisibility.FOLLOWERS_ONLY });
    await create({ oxyUserId: STRANGER });

    const ctx: FeedEngineContext = { currentUserId: VIEWER, fofIds: [FRIEND_A, FRIEND_B] };
    expect(idsOf(await friendsOfFriendsSource.gather(ctx, {}, 30))).toEqual([publicPost.id]);
  });

  it('returns nothing when the controller populated no friend-of-friend ids', async () => {
    await create({ oxyUserId: FRIEND_A });
    expect(await friendsOfFriendsSource.gather({ currentUserId: VIEWER }, {}, 30)).toEqual([]);
  });
});
