/**
 * The Following feed's VISIBILITY AUTHORIZATION, against a real database.
 *
 * One rule, and it is the reason this file is separate from the rest of the
 * source tests: **subscribing to a list is feed-inclusion, never a follow
 * relationship.** A followed author (and the viewer) may show PUBLIC or
 * FOLLOWERS_ONLY posts in this feed; an author who is only on a list the viewer
 * subscribed to may show PUBLIC posts and nothing else. Collapsing the two
 * branches into one id set silently grants followers-only READ ACCESS to
 * everyone on every list anyone subscribed to — an access-control failure that
 * looks, from the outside, like a slightly fuller feed.
 *
 * The suite this replaces asserted the SHAPE of a Mongo `$or`. That could not
 * distinguish a correct two-branch clause from one whose second branch matched
 * nothing, and there is no query object to inspect any more. Every case below
 * states an exact id set over rows that differ ONLY in the author's relationship
 * to the viewer and in the post's visibility — so a merged id set fails by
 * NAMING the post it should not have served.
 *
 * The whole set is naturally scoped: `followedAuthorsSql` is a correlated
 * `EXISTS` over `post_authorships` for THIS suite's author ids, so nothing a
 * sibling suite writes can enter the result and the id list can be compared
 * whole. Fixtures are still stamped fractionally in the future so their relative
 * order is stated rather than inherited from insertion timing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema';
import { insertPostRecord } from '../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../db/posts/postRecord';
import { followingSource } from '../mtn/feed/engine/sources/forYouSources';
import type { CandidatePost, FeedEngineContext } from '../mtn/feed/engine/types';

let db: Database;
const created: string[] = [];

const VIEWER = 'followfeed-viewer';
const FOLLOWED = 'followfeed-followed';
const LIST_ONLY = 'followfeed-list-only';
const STRANGER = 'followfeed-stranger';

const HORIZON = Date.now() + 60_000;

function at(offsetMs: number): Date {
  return new Date(HORIZON + offsetMs);
}

async function create(overrides: Partial<PostRecordInput> = {}): Promise<PostRecord> {
  const owner = overrides.oxyUserId === undefined ? STRANGER : overrides.oxyUserId;
  const record = await insertPostRecord({
    oxyUserId: owner,
    authorship: [{ oxyUserId: owner, role: 'owner', status: 'accepted' }],
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

function idsOf(records: readonly CandidatePost[]): string[] {
  return records.map((record) => record.id);
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

describe('the following timeline\'s visibility authorization', () => {
  /**
   * THE case. Every post here is `status: published` and every author is either
   * followed or subscribed-to, so the ONLY thing separating what is served from
   * what is withheld is which branch of the clause the author belongs to.
   *
   * Mutation: union the two id sets into one `followedAuthorsSql` and this goes
   * red naming `listFollowersOnly` — the followers-only post of somebody the
   * viewer never followed.
   */
  it('grants followers-only to follows and the viewer, and PUBLIC only to list members', async () => {
    const followedPublic = await create({ oxyUserId: FOLLOWED, createdAt: at(0) });
    const followedFollowersOnly = await create({
      oxyUserId: FOLLOWED,
      visibility: PostVisibility.FOLLOWERS_ONLY,
      createdAt: at(-1_000),
    });
    const ownFollowersOnly = await create({
      oxyUserId: VIEWER,
      visibility: PostVisibility.FOLLOWERS_ONLY,
      createdAt: at(-2_000),
    });
    const listPublic = await create({ oxyUserId: LIST_ONLY, createdAt: at(-3_000) });

    // Withheld, each for its own reason.
    await create({ oxyUserId: LIST_ONLY, visibility: PostVisibility.FOLLOWERS_ONLY });
    await create({ oxyUserId: LIST_ONLY, visibility: PostVisibility.PRIVATE });
    await create({ oxyUserId: FOLLOWED, visibility: PostVisibility.PRIVATE });
    await create({ oxyUserId: FOLLOWED, status: 'draft' });
    await create({ oxyUserId: STRANGER });

    const ctx: FeedEngineContext = {
      currentUserId: VIEWER,
      followingIds: [FOLLOWED],
      subscribedListMemberIds: [LIST_ONLY],
    };
    expect(idsOf(await followingSource.gather(ctx, { timeline: true }, 31))).toEqual([
      followedPublic.id,
      followedFollowersOnly.id,
      ownFollowersOnly.id,
      listPublic.id,
    ]);
  });

  /**
   * The overlap case: a list can name the viewer and people they already follow.
   *
   * Those ids belong in the FOLLOW-authorized branch, and the public-only branch
   * must not repeat them — repeated, the same post matches both branches of the
   * `OR`, which is harmless for the row set but was the thing the original
   * shape-assertion actually checked. What matters on rows is that being on a
   * list cannot DOWNGRADE an author the viewer follows: the followers-only posts
   * must still be served.
   */
  it('does not downgrade a followed author who also appears on a subscribed list', async () => {
    const followedFollowersOnly = await create({
      oxyUserId: FOLLOWED,
      visibility: PostVisibility.FOLLOWERS_ONLY,
      createdAt: at(0),
    });
    const ownFollowersOnly = await create({
      oxyUserId: VIEWER,
      visibility: PostVisibility.FOLLOWERS_ONLY,
      createdAt: at(-1_000),
    });
    const listPublic = await create({ oxyUserId: LIST_ONLY, createdAt: at(-2_000) });
    await create({ oxyUserId: LIST_ONLY, visibility: PostVisibility.FOLLOWERS_ONLY });

    const ctx: FeedEngineContext = {
      currentUserId: VIEWER,
      followingIds: [FOLLOWED],
      subscribedListMemberIds: [VIEWER, FOLLOWED, LIST_ONLY],
    };
    const gathered = await followingSource.gather(ctx, { timeline: true }, 31);
    expect(idsOf(gathered)).toEqual([followedFollowersOnly.id, ownFollowersOnly.id, listPublic.id]);
    // A post matching both branches of the `OR` is still ONE row.
    expect(new Set(idsOf(gathered)).size).toBe(gathered.length);
  });

  it('serves a subscribed list with no follows at all', async () => {
    // Subscription alone is enough to populate the feed — the follow branch
    // still matches the viewer's own posts, so an empty follow graph must not
    // short-circuit the whole query.
    const listPublic = await create({ oxyUserId: LIST_ONLY, createdAt: at(0) });
    const own = await create({ oxyUserId: VIEWER, createdAt: at(-1_000) });
    await create({ oxyUserId: LIST_ONLY, visibility: PostVisibility.FOLLOWERS_ONLY });

    const ctx: FeedEngineContext = {
      currentUserId: VIEWER,
      followingIds: [],
      subscribedListMemberIds: [LIST_ONLY],
    };
    expect(idsOf(await followingSource.gather(ctx, { timeline: true }, 31))).toEqual([
      listPublic.id,
      own.id,
    ]);
  });

  it('returns nothing when the viewer follows nobody and subscribes to nothing', async () => {
    // Not even the viewer's own posts: an empty Following feed is the honest
    // answer, and it is what makes the client show the "find people" state
    // rather than a feed of one.
    await create({ oxyUserId: VIEWER });
    await create({ oxyUserId: STRANGER });

    const ctx: FeedEngineContext = {
      currentUserId: VIEWER,
      followingIds: [],
      subscribedListMemberIds: [],
    };
    expect(await followingSource.gather(ctx, { timeline: true }, 31)).toEqual([]);
  });

  it('returns nothing for an anonymous viewer', async () => {
    await create({ oxyUserId: FOLLOWED });
    const ctx: FeedEngineContext = { followingIds: [FOLLOWED], subscribedListMemberIds: [] };
    expect(await followingSource.gather(ctx, { timeline: true }, 31)).toEqual([]);
  });

  it('serves a post the viewer\'s follow only COLLABORATED on', async () => {
    /**
     * The authorship match is a correlated `EXISTS` with `$elemMatch`
     * semantics — the id and the `accepted` status must hold on the SAME
     * authorship row. A plain join would let a post match by pairing the
     * followed author's id with a DIFFERENT entry's accepted status, which is
     * how a pending invitee's name reaches a feed before they consent.
     */
    const collaborated = await create({
      oxyUserId: STRANGER,
      createdAt: at(0),
      authorship: [
        { oxyUserId: STRANGER, role: 'owner', status: 'accepted' },
        { oxyUserId: FOLLOWED, role: 'collaborator', status: 'accepted' },
      ],
    });
    await create({
      oxyUserId: STRANGER,
      authorship: [
        { oxyUserId: STRANGER, role: 'owner', status: 'accepted' },
        { oxyUserId: FOLLOWED, role: 'collaborator', status: 'pending' },
      ],
    });

    const ctx: FeedEngineContext = {
      currentUserId: VIEWER,
      followingIds: [FOLLOWED],
      subscribedListMemberIds: [],
    };
    expect(idsOf(await followingSource.gather(ctx, { timeline: true }, 31))).toEqual([
      collaborated.id,
    ]);
  });
});
