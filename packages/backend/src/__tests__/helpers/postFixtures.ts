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
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { channels, lanes } from '../../db/schema/channels';
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
/**
 * Channels and lanes a scope created.
 *
 * Cleaned AFTER the posts, always: `posts.channel_id` is `ON DELETE CASCADE`, so
 * a channel removed first takes its posts with it — and a post the suite thinks
 * it deleted itself is a post whose absence proves nothing.
 */
const seededChannelIds = new Map<string, string[]>();
const seededLaneIds = new Map<string, string[]>();
/** Handles and lane names are unique; a counter keeps a suite's own distinct. */
let fixtureSeq = 0;

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
 * Insert one public channel owned by `ownerOxyUserId` (default: the scope's own
 * author), and return its id.
 *
 * A channel exists in these suites for exactly one reason — `posts.channel_id`
 * carries a foreign key, so "a post that belongs to a channel" is not a fixture
 * a suite can state without one.
 */
export async function seedChannel(
  scope: PostScope,
  overrides: Partial<typeof channels.$inferInsert> = {},
): Promise<string> {
  const handle = overrides.handle ?? `${scope.name}-chan-${fixtureSeq++}`;
  const [row] = await getDb()
    .insert(channels)
    .values({
      handle,
      handleLower: handle.toLowerCase(),
      title: overrides.title ?? 'a channel',
      ownerOxyUserId: overrides.ownerOxyUserId ?? scope.user('author'),
      ...overrides,
    })
    .returning({ id: channels.id });
  const existing = seededChannelIds.get(scope.name);
  if (existing) existing.push(row.id);
  else seededChannelIds.set(scope.name, [row.id]);
  return row.id;
}

/** Insert one lane and return its id. Defaults to a `mixed` lane owned by a user. */
export async function seedLane(
  scope: PostScope,
  overrides: Partial<typeof lanes.$inferInsert> = {},
): Promise<string> {
  const name = overrides.name ?? `${scope.name}-lane-${fixtureSeq++}`;
  const [row] = await getDb()
    .insert(lanes)
    .values({
      ownerType: overrides.ownerType ?? 'user',
      ownerId: overrides.ownerId ?? scope.user('author'),
      name,
      nameLower: name.toLowerCase(),
      ...overrides,
    })
    .returning({ id: lanes.id });
  const existing = seededLaneIds.get(scope.name);
  if (existing) existing.push(row.id);
  else seededLaneIds.set(scope.name, [row.id]);
  return row.id;
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
  // After the posts — see `seededChannelIds`.
  const channelIds = seededChannelIds.get(scope.name) ?? [];
  if (channelIds.length > 0) {
    await getDb().delete(channels).where(inArray(channels.id, channelIds.splice(0)));
  }
  const laneIds = seededLaneIds.get(scope.name) ?? [];
  if (laneIds.length > 0) {
    await getDb().delete(lanes).where(inArray(lanes.id, laneIds.splice(0)));
  }
}
