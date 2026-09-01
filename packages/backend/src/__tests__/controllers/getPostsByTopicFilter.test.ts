import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * The topic-page and hashtag-page predicates, against REAL ROWS.
 *
 * These used to assert the Mongo filter OBJECT each builder returned, which
 * proved only that the builder produced the literal someone typed into the test.
 * Both are now correlated `EXISTS` / array-containment SQL — the exact shapes
 * that render a bare column and silently match NOTHING (see `@oxyhq/db`) —
 * and an empty topic page is indistinguishable from "nobody posted about that",
 * so a shape assertion cannot guard them and a row assertion can.
 *
 * Three guarantees, each of which fails in its own direction:
 *  - a post carrying the topic as a Stage-B `topicRefs` entry matches;
 *  - a post carrying it only as a Stage-A slug in `postClassification.topics`
 *    ALSO matches (matching one and not the other is the original "trends but
 *    the topic page is empty" bug);
 *  - a private or unpublished post NEVER matches, whichever form it carries —
 *    topic and hashtag pages are public discovery surfaces.
 *
 * Stub the controller's runtime socket seam so importing it stays
 * pure/no-network.
 */
vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { CHRONO_DESC, deletePostRecord, findPostRecords, insertPostRecord } from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { chronoCursorSql } from '../../mtn/feed/CursorBuilder';
import { buildPostsByHashtagFilter, buildPostsByTopicFilter } from '../../controllers/posts/readPosts';

const AUTHOR = 'oxy-topic-author';
const created: string[] = [];

async function seed(overrides: Partial<PostRecordInput>): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'a post', tag: 'en' }] },
    ...overrides,
  });
  created.push(record.id);
  return record.id;
}

/** The ids the predicate actually selects, so a miss is a missing id, not a shape. */
async function matchedIds(where: Parameters<typeof findPostRecords>[0]): Promise<Set<string>> {
  const rows = await findPostRecords(where, { orderBy: CHRONO_DESC });
  return new Set(rows.filter((row) => created.includes(row.id)).map((row) => row.id));
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id, undefined);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('buildPostsByTopicFilter — canonical topicRefs.name OR slug topics match', () => {
  it('matches BOTH the registry-linked topicRefs.name and the slug-only topics list', async () => {
    const viaTopicRefs = await seed({
      postClassification: { topicRefs: [{ name: 'basketball' }] },
    });
    const viaSlugs = await seed({
      postClassification: { topics: ['basketball'] },
    });
    const unrelated = await seed({ postClassification: { topics: ['cooking'] } });

    const matched = await matchedIds(buildPostsByTopicFilter('Basketball'));

    expect(matched).toEqual(new Set([viaTopicRefs, viaSlugs]));
    expect(matched.has(unrelated)).toBe(false);
  });

  it('never exposes a private or unpublished post on the topic page', async () => {
    const publicPost = await seed({ postClassification: { topics: ['tech'] } });
    const privatePost = await seed({
      visibility: PostVisibility.PRIVATE,
      postClassification: { topics: ['tech'] },
    });
    const draft = await seed({ status: 'draft', postClassification: { topics: ['tech'] } });

    const matched = await matchedIds(buildPostsByTopicFilter('tech'));

    expect(matched).toEqual(new Set([publicPost]));
    expect(matched.has(privatePost)).toBe(false);
    expect(matched.has(draft)).toBe(false);
  });
});

describe('buildPostsByHashtagFilter — hashtag discovery visibility scope', () => {
  it('matches the normalized hashtag whatever case the caller supplies', async () => {
    const tagged = await seed({ hashtags: ['mixedcase'] });
    const other = await seed({ hashtags: ['different'] });

    const matched = await matchedIds(buildPostsByHashtagFilter('MixedCase'));

    expect(matched).toEqual(new Set([tagged]));
    expect(matched.has(other)).toBe(false);
  });

  it('never exposes a private or unpublished post on the hashtag page', async () => {
    const publicPost = await seed({ hashtags: ['tech'] });
    const followersOnly = await seed({
      visibility: PostVisibility.FOLLOWERS_ONLY,
      hashtags: ['tech'],
    });
    const scheduled = await seed({
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 60_000),
      hashtags: ['tech'],
    });

    const matched = await matchedIds(buildPostsByHashtagFilter('Tech'));

    expect(matched).toEqual(new Set([publicPost]));
    expect(matched.has(followersOnly)).toBe(false);
    expect(matched.has(scheduled)).toBe(false);
  });

  it('composes with a chronological keyset without dropping the ACL scope', async () => {
    const older = await seed({ hashtags: ['keyset'], createdAt: new Date('2026-01-01T00:00:00Z') });
    const newer = await seed({ hashtags: ['keyset'], createdAt: new Date('2026-02-01T00:00:00Z') });
    const privatePost = await seed({
      visibility: PostVisibility.PRIVATE,
      hashtags: ['keyset'],
      createdAt: new Date('2026-01-15T00:00:00Z'),
    });

    const keyset = await chronoCursorSql(`${new Date('2026-02-01T00:00:00Z').getTime()}:${newer}`);
    const matched = await matchedIds(and(buildPostsByHashtagFilter('keyset'), keyset));

    expect(matched).toEqual(new Set([older]));
    expect(matched.has(privatePost)).toBe(false);
  });
});
