/**
 * `stripRenderedQuoteMarkers` against REAL ROWS.
 *
 * The unit cases in `renderedQuoteMarker.test.ts` pin the text rule. This pins
 * the SELECT that chooses which rows it is applied to, which is where the safety
 * of the whole script lives: it may only touch a body whose post has a linked
 * quote, and the marker it removes must name THAT quote.
 *
 * A `noOpWrites`-style trap is deliberately covered too — the script counts what
 * Postgres reported modifying, so "we called update" cannot be mistaken for "the
 * row changed".
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { postContentVariants } from '../../db/schema/postContent';
import { insertPostRecord } from '../../db/posts/postRepository';
import { stripRenderedQuoteMarkers } from '../../scripts/stripRenderedQuoteMarkers';

const OWNER = 'strip-marker-owner';
const QUOTED_WEB = 'https://mastodon.social/@getkirby/116619403689196814';
const QUOTED_AP = 'https://mastodon.social/users/getkirby/statuses/116619403689196814';

const created: string[] = [];

async function seed(body: string, opts: { quoteOf?: string | null } = {}): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: OWNER,
    authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: body }] },
    federation: { activityId: `https://strip.test/notes/${created.length + 1}` },
    ...(opts.quoteOf !== undefined ? { quoteOf: opts.quoteOf } : {}),
  });
  created.push(record.id);
  return record.id;
}

/** The post being quoted, stored the way a real federated quote target is. */
async function seedQuoted(): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: OWNER,
    authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'the quoted original' }] },
    federation: { activityId: QUOTED_AP, actorUri: 'https://mastodon.social/users/getkirby', url: QUOTED_WEB },
  });
  created.push(record.id);
  return record.id;
}

async function bodyOf(postId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ body: postContentVariants.body })
    .from(postContentVariants)
    .where(eq(postContentVariants.postId, postId));
  return row?.body;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  if (created.length > 0) {
    await getDb().delete(posts).where(inArray(posts.id, [...created]));
    created.length = 0;
  }
});

describe('stripRenderedQuoteMarkers', () => {
  it('cleans a linked post whose marker names the quoted post by its WEB url', async () => {
    // The shape 99% of production rows are in: the marker renders the web url
    // while the note declared the AP id, so only reading `federation_url`
    // matches it.
    const quotedId = await seedQuoted();
    const postId = await seed(`RE: ${QUOTED_WEB}\n\nI heard there are 5 tickets left`, {
      quoteOf: quotedId,
    });

    const result = await stripRenderedQuoteMarkers({ dryRun: false });

    expect(await bodyOf(postId)).toBe('I heard there are 5 tickets left');
    expect(result.written).toBe(1);
    expect(result.noOpWrites).toBe(false);
  });

  it('LEAVES a post with no linked quote completely alone', async () => {
    // The safety term. Here the marker is the reader's only pointer at the
    // quoted post, so removing it would destroy the reference — and this is the
    // case that reds if `quote_of is not null` is dropped from the select.
    const body = `RE: ${QUOTED_WEB}\n\nI heard there are 5 tickets left`;
    const postId = await seed(body, { quoteOf: null });

    await stripRenderedQuoteMarkers({ dryRun: false });

    expect(await bodyOf(postId)).toBe(body);
  });

  it('LEAVES a marker that names some OTHER url, even on a linked post', async () => {
    // Removal matches a value we stored, not a pattern. A post that merely talks
    // about a different link keeps its text.
    const quotedId = await seedQuoted();
    const body = 'RE: https://example.com/unrelated\n\nbody';
    const postId = await seed(body, { quoteOf: quotedId });

    await stripRenderedQuoteMarkers({ dryRun: false });

    expect(await bodyOf(postId)).toBe(body);
  });

  it('a DRY RUN reports the work and writes nothing', async () => {
    const quotedId = await seedQuoted();
    const body = `RE: ${QUOTED_WEB}\n\nbody`;
    const postId = await seed(body, { quoteOf: quotedId });

    const result = await stripRenderedQuoteMarkers({ dryRun: true });

    expect(result.matched).toBe(1);
    expect(result.written).toBe(0);
    expect(await bodyOf(postId)).toBe(body);
  });

  it('is idempotent — a cleaned body is no longer a candidate', async () => {
    const quotedId = await seedQuoted();
    await seed(`RE: ${QUOTED_WEB}\n\nbody`, { quoteOf: quotedId });

    await stripRenderedQuoteMarkers({ dryRun: false });
    const second = await stripRenderedQuoteMarkers({ dryRun: false });

    expect(second.matched).toBe(0);
    expect(second.written).toBe(0);
  });
});
