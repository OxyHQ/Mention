/**
 * `trendTerms` — the `trend|<term>` feed's source — against real rows.
 *
 * The membership branch used to be decided inside SQL, as
 * `exists(member) OR (not exists(any member) AND term match)`. Postgres could
 * serve that with neither the membership index nor the term GINs, so it walked
 * `posts` newest-first and probed every row: 60–95s a page in production, past
 * the client's 15s timeout, for every signed-in reader.
 *
 * The branch is now decided in code. These tests pin that the answer did not
 * change with it:
 *
 *  1. a story with members shows exactly its members — not every post that
 *     happens to carry the term — newest first, and pages by cursor;
 *  2. a story without members, and a term with no `trending` row at all, show
 *     the term match.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { trending, trendStoryPosts } from '../../db/schema/discovery';
import { insertPostRecord } from '../../db/posts/postRepository';
import { ChronoCursor } from '../../mtn/feed/CursorBuilder';
import { trendTermsSource } from '../../mtn/feed/engine/sources/userSources';
import type { FeedEngineContext } from '../../mtn/feed/engine/types';

let db: Database;
const createdPostIds: string[] = [];
const createdTrendIds: string[] = [];

/** Terms are namespaced per run: sibling suites share one `posts` table. */
const RUN = randomUUID().slice(0, 8);
function term(name: string): string {
  return `${name}${RUN}`;
}

async function seedPost(termName: string, minutesAgo: number): Promise<string> {
  const author = `author-${RUN}-${createdPostIds.length}`;
  const record = await insertPostRecord({
    oxyUserId: author,
    authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
    status: 'published',
    visibility: 'public',
    createdAt: new Date(Date.now() - minutesAgo * 60 * 1000),
    content: { variants: [{ source: 'author', text: `about ${termName}` }] },
    postClassification: { trendTerms: [termName] },
  });
  createdPostIds.push(record.id);
  return record.id;
}

async function seedTrend(name: string, memberIds: string[] = []): Promise<void> {
  const [row] = await db
    .insert(trending)
    .values({ type: 'entity', name, terms: [name], score: 1, rank: 0, calculatedAt: new Date() })
    .returning({ id: trending.id });
  createdTrendIds.push(row.id);
  if (memberIds.length > 0) {
    await db.insert(trendStoryPosts).values(
      memberIds.map((postId) => ({
        trendId: row.id,
        postId,
        relevance: 1,
        matchedTerms: [name],
      })),
    );
  }
}

async function gather(termName: string, cap: number, cursor?: string): Promise<string[]> {
  const ctx = { cursor } as FeedEngineContext;
  const page = await trendTermsSource.gather(ctx, { term: termName }, cap);
  return page.map((post) => post.id);
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdTrendIds.length > 0) {
    await db.delete(trending).where(inArray(trending.id, createdTrendIds));
    createdTrendIds.length = 0;
  }
  if (createdPostIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, createdPostIds));
    createdPostIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('trendTermsSource', () => {
  it('shows exactly the story’s members, newest first, paged by cursor', async () => {
    const name = term('story');
    const oldest = await seedPost(name, 30);
    const middle = await seedPost(name, 20);
    const newest = await seedPost(name, 10);
    // Carries the term but was not admitted to the story.
    await seedPost(name, 5);
    await seedTrend(name, [oldest, middle, newest]);

    expect(await gather(name, 10)).toEqual([newest, middle, oldest]);

    const [firstPost] = await db
      .select({ id: posts.id, createdAt: posts.createdAt })
      .from(posts)
      .where(inArray(posts.id, [middle]));
    const cursor = ChronoCursor.build(firstPost.id, firstPost.createdAt);
    expect(await gather(name, 10, cursor)).toEqual([oldest]);
  });

  it('matches the term when the story has no members', async () => {
    const name = term('unstoried');
    const older = await seedPost(name, 20);
    const newer = await seedPost(name, 10);
    await seedTrend(name);

    expect(await gather(name, 10)).toEqual([newer, older]);
  });

  it('matches the term when no trend row exists', async () => {
    const name = term('rowless');
    const only = await seedPost(name, 10);

    expect(await gather(name, 10)).toEqual([only]);
  });
});
