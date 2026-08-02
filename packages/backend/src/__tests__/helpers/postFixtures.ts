/**
 * Real `posts` rows for the suites that are about posts rather than federation.
 *
 * These suites used to mock `models/Post` wholesale. A mocked model answers
 * whatever the mock was told to answer, so an assertion could read "the reply
 * was stored with its parent" while observing only that `create` had been
 * CALLED — and could not tell a correct query from one that silently matches
 * nothing. Every post read is Postgres now, so the rows are real.
 *
 * ## Every fixture is namespaced, because vitest runs files in parallel
 *
 * One database serves the whole run. A suite that deleted "all posts" in its
 * teardown would delete another file's rows mid-assertion, so {@link postScope}
 * derives a per-file prefix, every id this helper mints is recorded, and
 * cleanup deletes exactly those. Ids rather than a predicate, because `posts`
 * carries no column holding the suite's name and a federated post's activity id
 * is often a URL the suite chose.
 *
 * The scope is passed in rather than inferred so it is visible in the suite that
 * owns it — an inferred one silently collides when two files pick the same name.
 * This mirrors `federationFixtures.ts`, which owns the same job for the suites
 * that also need actors and follow edges; use that one when a suite needs both.
 */

import { PostType, PostVisibility } from '@mention/shared-types';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { deletePostRecord, insertPostRecord } from '../../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../../db/posts/postRecord';
import { posts } from '../../db/schema/posts';

export interface PostScope {
  /** The suite's name, as passed to {@link postScope}. */
  readonly name: string;
  /** A stable, suite-unique Oxy account id. */
  user(label: string): string;
}

const seededIds = new Map<string, string[]>();

/** Derive a per-file fixture scope. Pass the suite's own name. */
export function postScope(name: string): PostScope {
  return {
    name,
    user: (label: string) => `oxy-${name}-${label}`,
  };
}

/**
 * Insert one post and return the record production code reads back.
 *
 * The defaults describe a healthy, public, published, locally-authored text
 * post, so a suite states only the fact it is about.
 */
export async function seedPost(
  scope: PostScope,
  overrides: Partial<PostRecordInput> = {},
): Promise<PostRecord> {
  const owner = (overrides.oxyUserId ?? scope.user('author')) as string;
  const record = await insertPostRecord({
    oxyUserId: owner,
    authorship: [{ oxyUserId: owner, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'a post', tag: 'en' }] },
    ...overrides,
  });
  track(scope, record.id);
  return record;
}

/**
 * Record an id the PRODUCTION code under test created, so teardown removes it.
 *
 * A suite that exercises a create path owns rows it never seeded; without this
 * they survive the file and answer another suite's query.
 */
export function track(scope: PostScope, id: string): void {
  const existing = seededIds.get(scope.name);
  if (existing) existing.push(id);
  else seededIds.set(scope.name, [id]);
}

/** The stored row, for asserting what a write path actually persisted. */
export async function readPostRow(
  id: string,
): Promise<typeof posts.$inferSelect | undefined> {
  const [row] = await getDb().select().from(posts).where(eq(posts.id, id));
  return row;
}

/**
 * Remove every row this scope created — and only those.
 *
 * Newest first, so a reply or boost is removed before the post it references
 * rather than being cascaded or set-null'd out from under the delete.
 */
export async function clearPostScope(scope: PostScope): Promise<void> {
  const ids = seededIds.get(scope.name) ?? [];
  for (const id of ids.splice(0).reverse()) {
    await deletePostRecord(id, undefined);
  }
}
