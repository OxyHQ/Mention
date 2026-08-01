/**
 * The Videos (Reels) CONTENT predicate, against a real database.
 *
 * ## What changed, and why the old shape of this suite could not survive
 *
 * `buildVideosQuery` used to return a Mongo match OBJECT, and this suite read
 * keys out of it — `elemMatch.orientation`, `and.find(c => …$nin…)`. It also
 * carried a hand-written `matchesVideosFeed()` predicate that RESTATED the query
 * in TypeScript and then tested that restatement. Both are gone, and the second
 * is the more important loss: it could only ever agree with itself. A drifted
 * clause, a `$elemMatch` that spread its conditions across two media items, an
 * `oxy_user_id IS NULL` row silently dropped by three-valued logic — none of that
 * is visible to either technique. The builder now returns a drizzle `SQL`
 * predicate, so the only honest question left is WHICH ROWS COME BACK.
 *
 * ## The property under test
 *
 * A qualifying post is public, published, not a boost, and carries at least one
 * media item that is a video with real dimensions on ONE row (Mongo's
 * `$elemMatch` semantics, now a correlated `EXISTS`). Federated posts qualify on
 * exactly the same terms as native ones — the videos corpus is almost entirely
 * federated, and a federation exclusion here would empty the feed.
 *
 * Every assertion is an EXACT id set. A feed that quietly returns FEWER rows
 * looks like a ranking change rather than a bug, which is the whole failure mode
 * this file exists to catch.
 *
 * ## Two cases that moved rather than died
 *
 * - "bounds `_id` no further" is now a ROW question about the source, not a
 *   shape question about the builder — the builder's signature no longer accepts
 *   a cursor at all. It lives in `rankedSourceCandidateWindow.test.ts`, asserted
 *   against the pool the source actually returns.
 * - The duration/orientation option matrix lives in `videosFeedMetadata.test.ts`
 *   and `videosQueryUnknownMetadata.test.ts`; this file pins the base predicate.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  isValidFeedDescriptor,
  parseFeedDescriptor,
  PostType,
  PostVisibility,
} from '@mention/shared-types';
import type { MediaItem } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { CHRONO_DESC, findPostRecords, insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import { FeedQueryBuilder } from '../utils/feedQueryBuilder';

let db: Database;

/** Unique to this file: the suite runs in parallel against ONE database. */
const AUTHOR = 'videos-feed-author';

/** A video item with every field the default predicate requires. */
const PORTRAIT_VIDEO: MediaItem = {
  id: 'media-portrait',
  type: 'video',
  width: 1080,
  height: 1920,
  durationSec: 30,
  orientation: 'portrait',
};

function baseInput(overrides: Partial<PostRecordInput> = {}): PostRecordInput {
  return {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.VIDEO,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'clip' }], media: [PORTRAIT_VIDEO] },
    ...overrides,
  };
}

async function create(overrides: Partial<PostRecordInput> = {}): Promise<string> {
  const record = await insertPostRecord(baseInput(overrides));
  return record.id;
}

/**
 * The ids the default videos predicate admits, SCOPED to this file's author.
 *
 * The scope is not cosmetic: test files run in parallel workers against a single
 * throwaway database, so an unscoped `buildVideosQuery` would also return
 * whatever a concurrent suite happened to have inserted, and an exact-set
 * assertion would fail on other people's rows.
 */
async function admitted(seenPostIds: readonly string[] = []): Promise<string[]> {
  const records = await findPostRecords(
    and(FeedQueryBuilder.buildVideosQuery(seenPostIds), eq(posts.oxyUserId, AUTHOR)),
    { orderBy: CHRONO_DESC },
  );
  return records.map((record) => record.id).sort();
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  await db.delete(posts).where(eq(posts.oxyUserId, AUTHOR));
});

afterAll(async () => {
  await closePostgres();
});

describe('videos feed descriptor', () => {
  it('recognizes "videos" as a valid feed descriptor', () => {
    expect(isValidFeedDescriptor('videos')).toBe(true);
  });

  it('parses the "videos" descriptor with no params', () => {
    const parsed = parseFeedDescriptor('videos');
    expect(parsed.source).toBe('videos');
    expect(parsed.params).toEqual([]);
  });
});

describe('the videos content predicate', () => {
  it('admits native and federated video posts alike, and nothing else', async () => {
    /**
     * ONE case covering the whole inclusion/exclusion table, because the value is
     * in the SET being exact: asserting each row in isolation would pass just as
     * happily against a predicate that admits everything.
     *
     * The federated fixture is typed IMAGE on purpose — remote instances type
     * their posts however they like, and Mention's videos feed keys off the MEDIA
     * ROW, never off `posts.type`.
     */
    const native = await create();
    const federated = await create({
      type: PostType.IMAGE,
      federation: {
        activityId: 'https://remote.example/users/alice/statuses/1',
        actorUri: 'https://remote.example/users/alice',
      },
    });

    // …and every shape that must NOT come back.
    const textOnly = await create({
      type: PostType.TEXT,
      content: { variants: [{ source: 'author', text: 'just text' }] },
    });
    const missingDimensions = await create({
      content: {
        variants: [{ source: 'author', text: 'no metadata' }],
        media: [{ id: 'media-bare', type: 'video', orientation: 'portrait' }],
      },
    });
    const imageOnly = await create({
      type: PostType.IMAGE,
      content: {
        variants: [{ source: 'author', text: 'a photo' }],
        media: [{ id: 'media-photo', type: 'image', width: 1080, height: 1920, orientation: 'portrait' }],
      },
    });
    const followersOnly = await create({ visibility: PostVisibility.FOLLOWERS_ONLY });
    const draft = await create({ status: 'draft' });
    const restricted = await create({ status: 'restricted' });

    const original = await create();
    const boost = await create({
      type: PostType.BOOST,
      boostOf: original,
      content: { variants: [], media: [PORTRAIT_VIDEO] },
    });

    expect(await admitted()).toEqual([native, federated, original].sort());
    // Named so a failure says WHICH exclusion broke rather than just "sets differ".
    const excluded = [textOnly, missingDimensions, imageOnly, followersOnly, draft, restricted, boost];
    expect((await admitted()).filter((id) => excluded.includes(id))).toEqual([]);
  });

  it('requires the video conditions to hold on ONE media row, not across several', async () => {
    /**
     * The `$elemMatch` semantics, which a naive translation loses: a post
     * carrying a landscape VIDEO and a portrait IMAGE satisfies "has a video" and
     * "has a portrait item" separately, and must still be rejected because no
     * single row satisfies both. A predicate built as independent `EXISTS` terms
     * (or as bare `AND`s over the joined table) admits it.
     */
    const spreadAcross = await create({
      content: {
        variants: [{ source: 'author', text: 'mixed gallery' }],
        media: [
          { id: 'media-wide-video', type: 'video', width: 1920, height: 1080, orientation: 'landscape', durationSec: 30 },
          { id: 'media-tall-image', type: 'image', width: 1080, height: 1920, orientation: 'portrait' },
        ],
      },
    });
    const genuine = await create();

    expect(await admitted()).toEqual([genuine]);
    expect(await admitted()).not.toContain(spreadAcross);
  });

  it('admits a REPLY, so a multi-post thread can still be sliced', async () => {
    // Replies deliberately flow through this predicate — unlike Explore, which
    // excludes them. A reply dropped here is a thread that renders with a hole.
    const parent = await create();
    const reply = await create({ parentPostId: parent });

    const ids = await admitted();
    expect(ids).toEqual([parent, reply].sort());
  });

  it('drops exactly the seen ids and leaves the rest of the set intact', async () => {
    const seen = await create();
    const first = await create();
    const second = await create();

    expect(await admitted()).toEqual([seen, first, second].sort());
    expect(await admitted([seen])).toEqual([first, second].sort());
    // An empty seen set must drop the term entirely rather than emit a
    // degenerate `NOT IN ()`, which matches nothing at all in SQL.
    expect(await admitted([])).toEqual([seen, first, second].sort());
  });

  it('tolerates a seen id that names no row', async () => {
    // The Mongo original filtered the incoming ids through `ObjectId.isValid` to
    // dodge a `CastError`. Ids are `text` now, so an unknown one is simply an id
    // that excludes nothing — never an error, and never an empty page.
    const kept = await create();
    expect(await admitted(['no-such-post-id'])).toEqual([kept]);
  });
});
