/**
 * The global Media feed's CONTENT predicate, against a real database.
 *
 * ## What this replaces
 *
 * The predecessor asserted the Mongo match object `buildMediaFeedQuery` returned
 * (`$or` containing `{'content.media.0': {$exists: true}}`, and so on) and then
 * separately tested a hand-written `matchesMediaFeed()` that RESTATED the same
 * rule in TypeScript. Neither could observe a row. The restatement in particular
 * could only ever agree with itself: it would have stayed green through the
 * entire Mongo→Postgres port while the real query returned nothing.
 *
 * ## The property under test
 *
 * "Carries media" is a THREE-WAY disjunction, and each arm exists because a real
 * corpus needs it:
 *
 *  1. `type` is IMAGE or VIDEO — a native post whose media rows may not have
 *     landed yet, or whose media lives on a variant.
 *  2. at least one `post_media` row — the federated majority, which arrives typed
 *     TEXT and carries its attachments as media rows.
 *  3. a `media` ATTACHMENT descriptor — a post whose media is described but not
 *     enumerated.
 *
 * The disjunction is why the exact-set assertions below matter more than usual:
 * losing ONE arm still leaves a feed that returns plenty of posts, so nothing
 * looks broken — it looks like a ranking change. The suite pins each arm in
 * isolation AND the whole set together.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  isValidFeedDescriptor,
  parseFeedDescriptor,
  PostType,
  PostVisibility,
} from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { CHRONO_DESC, findPostRecords, insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import { FeedQueryBuilder } from '../utils/feedQueryBuilder';
import { mediaSource } from '../mtn/feed/engine/sources/discoverySources';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

let db: Database;

/** Unique to this file: the suite runs in parallel against ONE database. */
const AUTHOR = 'media-feed-author';

function baseInput(overrides: Partial<PostRecordInput> = {}): PostRecordInput {
  return {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'body' }] },
    ...overrides,
  };
}

async function create(overrides: Partial<PostRecordInput> = {}): Promise<string> {
  const record = await insertPostRecord(baseInput(overrides));
  return record.id;
}

/** Ids the media predicate admits, scoped to this file's author. */
async function admitted(seenPostIds: readonly string[] = []): Promise<string[]> {
  const records = await findPostRecords(
    and(FeedQueryBuilder.buildMediaFeedQuery(seenPostIds), eq(posts.oxyUserId, AUTHOR)),
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

describe('media feed descriptor', () => {
  it('recognizes "media" as a valid feed descriptor', () => {
    expect(isValidFeedDescriptor('media')).toBe(true);
  });

  it('parses the "media" descriptor with no params', () => {
    const parsed = parseFeedDescriptor('media');
    expect(parsed.source).toBe('media');
    expect(parsed.params).toEqual([]);
  });
});

describe('each arm of the "carries media" disjunction', () => {
  it('admits an IMAGE-typed post that has no media ROW yet', async () => {
    // Arm 1 alone. If the type arm were dropped this is the only fixture that
    // notices, and a feed missing it still looks perfectly healthy.
    const typedOnly = await create({ type: PostType.IMAGE });
    expect(await admitted()).toEqual([typedOnly]);
  });

  it('admits a VIDEO-typed post that has no media ROW yet', async () => {
    const typedOnly = await create({ type: PostType.VIDEO });
    expect(await admitted()).toEqual([typedOnly]);
  });

  it('admits a TEXT-typed post carrying a media row — the federated shape', async () => {
    // Arm 2 alone. Remote instances type their posts however they like; keying
    // this feed off `posts.type` would empty it of federated content.
    const federated = await create({
      content: {
        variants: [{ source: 'author', text: 'remote photo' }],
        media: [{ id: 'media-remote', type: 'image' }],
      },
      federation: { activityId: 'https://remote.example/notes/1' },
    });
    expect(await admitted()).toEqual([federated]);
  });

  it('admits a post whose media is only DESCRIBED by an attachment', async () => {
    // Arm 3 alone.
    const described = await create({
      content: {
        variants: [{ source: 'author', text: 'with attachment' }],
        // `attachment_id` and `media_type` are BOTH required on a `media`
        // descriptor (`post_attachments_media_fields_check`) — Mongo's
        // conditionally-`required` validator, now a constraint.
        attachments: [{ type: 'media', id: 'media-described', mediaType: 'image' }],
      },
    });
    expect(await admitted()).toEqual([described]);
  });

  it('does not treat a non-media attachment as media', async () => {
    // The attachment arm matches on `type = 'media'` specifically. A `sources`
    // or `poll` attachment is not media, and admitting it would fill the Media
    // feed with text posts that render as a blank tile.
    await create({
      content: {
        variants: [{ source: 'author', text: 'links' }],
        attachments: [{ type: 'sources' }],
      },
      hasLinks: true,
    });
    await create({
      content: { variants: [{ source: 'author', text: 'a poll' }], attachments: [{ type: 'poll' }] },
    });

    expect(await admitted()).toEqual([]);
  });
});

describe('the media predicate as a whole', () => {
  it('admits every media shape and nothing else, in one exact set', async () => {
    const imageTyped = await create({ type: PostType.IMAGE });
    const videoTyped = await create({ type: PostType.VIDEO });
    const mediaRow = await create({
      content: {
        variants: [{ source: 'author', text: 'photo' }],
        media: [{ id: 'media-1', type: 'image' }],
      },
    });
    const attachmentOnly = await create({
      content: {
        variants: [{ source: 'author', text: 'attached' }],
        attachments: [{ type: 'media', id: 'media-attached', mediaType: 'video' }],
      },
    });

    const textOnly = await create();
    const followersOnly = await create({ type: PostType.IMAGE, visibility: PostVisibility.FOLLOWERS_ONLY });
    const draft = await create({ type: PostType.IMAGE, status: 'draft' });
    const restricted = await create({ type: PostType.IMAGE, status: 'restricted' });

    const original = await create({ type: PostType.IMAGE });
    const boost = await create({
      type: PostType.BOOST,
      boostOf: original,
      content: { variants: [], media: [{ id: 'media-boosted', type: 'image' }] },
    });

    expect(await admitted()).toEqual(
      [imageTyped, videoTyped, mediaRow, attachmentOnly, original].sort(),
    );
    const excluded = [textOnly, followersOnly, draft, restricted, boost];
    expect((await admitted()).filter((id) => excluded.includes(id))).toEqual([]);
  });

  it('excludes a boost even when it carries media of its own', async () => {
    // Stated separately because it is the one exclusion with a REASON beyond
    // "wrong shape": the boosted ORIGINAL is what the feed surfaces, so admitting
    // the boost would double the original in the same page.
    const original = await create({ type: PostType.IMAGE });
    const boost = await create({
      type: PostType.BOOST,
      boostOf: original,
      content: { variants: [], media: [{ id: 'media-boost', type: 'image' }] },
    });

    const ids = await admitted();
    expect(ids).toEqual([original]);
    expect(ids).not.toContain(boost);
  });

  it('admits a REPLY, so a multi-post thread can still be sliced', async () => {
    const parent = await create({ type: PostType.IMAGE });
    const reply = await create({ type: PostType.IMAGE, parentPostId: parent });
    expect(await admitted()).toEqual([parent, reply].sort());
  });

  it('drops exactly the seen ids and leaves the rest of the set intact', async () => {
    const seen = await create({ type: PostType.IMAGE });
    const kept = await create({ type: PostType.IMAGE });

    expect(await admitted()).toEqual([seen, kept].sort());
    expect(await admitted([seen])).toEqual([kept]);
    // An empty seen set must drop the term rather than emit a degenerate
    // `NOT IN ()`, which matches nothing at all in SQL.
    expect(await admitted([])).toEqual([seen, kept].sort());
  });
});

describe('the media source composes the predicate with the discovery safety gate', () => {
  it('withholds a sensitive media post from the ranked pool', async () => {
    // The source ANDs `discoverySafeSql()` onto the content predicate. Asserted
    // here rather than in the safety module's own suite because the question is
    // whether THIS source wired the gate up.
    const safe = await create({ type: PostType.IMAGE });
    const sensitive = await create({ type: PostType.IMAGE, metadata: { isSensitive: true } });
    const nsfwTagged = await create({ type: PostType.IMAGE, hashtags: ['nsfw'] });

    const pool = await mediaSource.gather({} as FeedEngineContext, {}, 500);
    const mine = pool
      .map((candidate) => candidate.id)
      .filter((id) => [safe, sensitive, nsfwTagged].includes(id));
    expect(mine).toEqual([safe]);
  });
});
