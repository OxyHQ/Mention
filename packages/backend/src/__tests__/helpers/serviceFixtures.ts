/**
 * Real `posts` rows for the SERVICE and CONTROLLER suites (batch 7).
 *
 * These suites used to mock `models/Post` — usually by capturing the object
 * handed to `new Post(...)` and asserting on it. That answers "was a document
 * built with these fields?", which is a different question from "is that what
 * the database now holds": it cannot see a column the writer forgot to map, a
 * value the schema coerced, or a query whose correlated subquery silently
 * matches nothing. Every post read and write is Postgres now, so these fixtures
 * are real rows and the assertions are about rows.
 *
 * ## Every fixture is namespaced, because vitest runs files in parallel
 *
 * One database serves the whole run, and `maxWorkers` is 10. A suite that seeds
 * a literal `'author-oxy'` sees whatever another file seeded under the same
 * name, and a teardown that deleted "all posts" would delete another file's rows
 * mid-assertion. {@link serviceScope} derives a per-file prefix, every account id
 * a suite uses is built from it, and cleanup deletes only what carries that
 * prefix (plus any id explicitly {@link trackPost}ed).
 *
 * The scope is passed in rather than inferred so it is visible in the suite that
 * owns it — an inferred one silently collides when two files pick the same name.
 *
 * This is deliberately a SEPARATE file from `postFixtures.ts` /
 * `federationFixtures.ts`, which other batches own concurrently: a shared helper
 * edited by two sessions at once is the one collision that costs everybody.
 */

import { PostType, PostVisibility } from '@mention/shared-types';
import { like } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { deletePostRecord, insertPostRecord, loadPostRecord } from '../../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../../db/posts/postRecord';
import { posts } from '../../db/schema/posts';

/** A suite's private namespace for the rows it creates. */
export interface ServiceScope {
  /** The suite's name, as passed to {@link serviceScope}. */
  readonly name: string;
  /** A stable, suite-unique Oxy account id. */
  user(label: string): string;
}

/**
 * Ids the suite (or the production code it drove) created, so teardown reaches a
 * row whose owner column does not carry the scope prefix — a federated post has
 * `oxy_user_id` NULL, and a controller may attribute a post to an id the suite
 * did not mint.
 */
const seededIds = new Map<string, string[]>();

/**
 * Retry an operation that lost a Postgres DEADLOCK (`40P01`).
 *
 * Ten suites write and delete `posts` rows concurrently against one database,
 * and `posts` self-references itself four times (`parent_post_id`, `thread_id`
 * and `quote_of` are `ON DELETE SET NULL`, `boost_of` cascades), so a delete
 * takes locks beyond the rows it names. Observed under a mixed run of these
 * suites plus the feed suites: `40P01` on a bulk delete, taking down whichever
 * side the detector chose — sometimes a suite here, sometimes an unrelated one.
 * Every self-referencing column IS indexed on its own leading column
 * (`post_replies_chrono_v1`, `posts_thread_idx`, `posts_quote_of_idx`,
 * `posts_boost_of_idx`), so this is ordinary lock-order contention rather than a
 * missing index — which is why the answer is a retry and not a schema change.
 *
 * A losing transaction is told to retry, and that is all this does. It is
 * deliberately NOT a blanket catch: only `40P01` is retried, so a real
 * constraint violation still fails the test immediately.
 */
export async function withDeadlockRetry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as { code?: string; cause?: { code?: string } }).code
        ?? (error as { cause?: { code?: string } }).cause?.code;
      if (code !== '40P01' || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

/** Derive a per-file fixture scope. Pass the suite's own name. */
export function serviceScope(name: string): ServiceScope {
  return {
    name,
    user: (label: string) => `oxy-${name}-${label}`,
  };
}

/** The owner-id prefix every account this scope mints starts with. */
function ownerPrefix(scope: ServiceScope): string {
  return `oxy-${scope.name}-`;
}

/**
 * Record an id so teardown removes it.
 *
 * A suite that exercises a CREATE path owns rows it never seeded; without this
 * they survive the file and answer another suite's query.
 */
export function trackPost(scope: ServiceScope, id: string): void {
  const existing = seededIds.get(scope.name);
  if (existing) existing.push(id);
  else seededIds.set(scope.name, [id]);
}

/**
 * Insert one post and return the record production code reads back.
 *
 * The defaults describe a healthy, public, published, locally-authored text post
 * whose Stage-A classification has run, so a suite states only the fact it is
 * about. The default owner is namespaced; pass `oxyUserId` only when the suite
 * is about WHO owns it, and build that id from {@link ServiceScope.user}.
 */
export async function seedPost(
  scope: ServiceScope,
  overrides: Partial<PostRecordInput> = {},
): Promise<PostRecord> {
  const owner = 'oxyUserId' in overrides ? overrides.oxyUserId : scope.user('author');
  const record = await withDeadlockRetry(() =>
    insertPostRecord({
      oxyUserId: owner ?? null,
      authorship: owner ? [{ oxyUserId: owner, role: 'owner', status: 'accepted' }] : [],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'a post', tag: 'en' }] },
      ...overrides,
    }),
  );
  trackPost(scope, record.id);
  return record;
}

/** The assembled record, for asserting what a write path actually persisted. */
export async function readPost(id: string): Promise<PostRecord | null> {
  return loadPostRecord(id);
}

/**
 * Every post this scope's accounts own, oldest first.
 *
 * The way to read back rows a CREATE path wrote when the suite never learned
 * their ids — a controller that only returns hydrated DTOs, for instance.
 */
export async function readScopePosts(scope: ServiceScope): Promise<Array<typeof posts.$inferSelect>> {
  return getDb()
    .select()
    .from(posts)
    .where(like(posts.oxyUserId, `${ownerPrefix(scope)}%`))
    .orderBy(posts.createdAt, posts.id);
}

/**
 * Remove every row this scope created — and ONLY those.
 *
 * Two predicates, because a scope's rows are reachable by two different handles:
 * the namespaced owner id (which covers everything a suite or the code under
 * test wrote for one of its accounts) and the explicitly tracked ids (which
 * cover a federated post with a NULL owner, or one attributed to an id the suite
 * did not mint).
 *
 * Tracked ids go newest-first so a reply or boost is removed before the post it
 * references, rather than being cascaded or set-null'd out from under the
 * delete. The owner sweep then runs as one statement: `boostOf` cascades and
 * every other self-reference is `ON DELETE SET NULL`, so no ordering is needed
 * once the set is deleted together.
 */
export async function clearServiceScope(scope: ServiceScope): Promise<void> {
  const ids = seededIds.get(scope.name) ?? [];
  for (const id of ids.splice(0).reverse()) {
    await withDeadlockRetry(() => deletePostRecord(id, undefined));
  }
  await withDeadlockRetry(() =>
    getDb()
      .delete(posts)
      .where(like(posts.oxyUserId, `${ownerPrefix(scope)}%`)),
  );
}

