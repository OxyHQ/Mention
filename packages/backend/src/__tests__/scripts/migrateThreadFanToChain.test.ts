/**
 * The broken-fan → chain thread repair, against REAL ROWS.
 *
 * The previous version mocked `Post.aggregate` and handed the script a canned
 * candidate list, so the half that DECIDES what a candidate is never ran. That
 * half is where the safety lives: a `GROUP BY thread_id` with a three-part
 * `HAVING` (2+ members, ZERO already-chained members, exactly one distinct
 * author) restricted to native posts. Re-chaining a real reply tree by creation
 * order corrupts a conversation, and the `HAVING` is the only thing standing
 * between the two.
 *
 * Both halves run for real. Every case seeds the thread it is about and asserts
 * the stored `parent_post_id` chain afterwards.
 *
 * ## The ordering key is `created_at`, not the id, and that is load-bearing
 *
 * The Mongo version sorted by ascending `_id` because an ObjectId encodes its
 * creation time. `posts.id` holds ObjectId hex for pre-cutover rows and uuid v7
 * after, and the two interleave under text collation (`'0' < '6'`), so an
 * id-ordered re-chain would put a thread that straddles the cutover in the wrong
 * order — reintroducing the exact defect the script repairs. The case that pins
 * this seeds ids in the reverse of their creation order.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import type { PostRecord, PostRecordInput } from '../../db/posts/postRecord';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import migrateThreadFanToChain from '../../scripts/migrateThreadFanToChain';

const scope = postScope('thread-fan-to-chain');
const AUTHOR = scope.user('author');
const OTHER = scope.user('other');

/** Minute `n` of a fixed hour, so creation order is explicit rather than implied. */
function minute(n: number): Date {
  return new Date(Date.UTC(2026, 4, 1, 12, n));
}

async function seedThreadPost(
  author: string,
  overrides: Partial<PostRecordInput> = {},
): Promise<PostRecord> {
  return seedPost(scope, {
    oxyUserId: author,
    authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
    ...overrides,
  });
}

/**
 * A broken fan's ROOT, given a parent post of its own.
 *
 * The parent is protection against a SIBLING SUITE, not part of the fixture's
 * meaning. `backfillThreadRootThreadId` is another corpus-wide one-shot with its
 * own file, vitest runs files in parallel against one database, and a root it
 * stamps stops being a broken fan: the root joins its own thread group with
 * `parent_post_id` NULL while `thread_id` is set, which is one non-fan member,
 * so the `HAVING … = 0` gate skips the thread and this file fails intermittently
 * (measured — it did). A root that is itself a reply is invisible to that
 * script's fifth guard and provably irrelevant to this one: `loadRootAuthors`
 * reads only `id` and `oxy_user_id`, and no predicate here mentions the root's
 * parent link.
 *
 * That interference is REAL beyond the test harness — see the ordering case at
 * the end of this file.
 */
async function seedFanRoot(author: string, overrides: Partial<PostRecordInput> = {}) {
  const anchor = await seedThreadPost(author, { createdAt: minute(0) });
  return seedThreadPost(author, { parentPostId: anchor.id, ...overrides });
}

/**
 * A root plus `count` continuations in the BROKEN shape: every continuation
 * points its `parentPostId` at the root, which is what the old `createThread`
 * produced.
 */
async function seedFan(options: {
  count: number;
  author?: string;
  continuationAuthors?: string[];
  continuationOverrides?: Array<Partial<PostRecordInput>>;
  root?: Partial<PostRecordInput>;
}): Promise<{ rootId: string; continuationIds: string[] }> {
  const root = await seedFanRoot(options.author ?? AUTHOR, options.root);
  const continuationIds: string[] = [];
  for (let i = 0; i < options.count; i += 1) {
    const post = await seedThreadPost(options.continuationAuthors?.[i] ?? options.author ?? AUTHOR, {
      parentPostId: root.id,
      threadId: root.id,
      createdAt: minute(i + 1),
      ...(options.continuationOverrides?.[i] ?? {}),
    });
    continuationIds.push(post.id);
  }
  return { rootId: root.id, continuationIds };
}

/** `id -> parent_post_id`, as stored. */
async function parentsOf(ids: string[]): Promise<Map<string, string | null>> {
  const rows = await getDb()
    .select({ id: posts.id, parentPostId: posts.parentPostId })
    .from(posts)
    .where(inArray(posts.id, ids));
  return new Map(rows.map((row) => [row.id, row.parentPostId]));
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.stubEnv('CONFIRM_ADMIN_MUTATION', 'migrateThreadFanToChain');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('migrateThreadFanToChain', () => {
  it('re-links a 3-continuation fan into a sequential chain, first keeping the root parent', async () => {
    const { rootId, continuationIds } = await seedFan({ count: 3 });

    await migrateThreadFanToChain();

    const parents = await parentsOf(continuationIds);
    expect(parents.get(continuationIds[0])).toBe(rootId);
    expect(parents.get(continuationIds[1])).toBe(continuationIds[0]);
    expect(parents.get(continuationIds[2])).toBe(continuationIds[1]);
  });

  it('chains by CREATION TIME, not by id order', async () => {
    // The ids straddle the cutover and are seeded so that id order disagrees
    // with creation order: uuid v7 sorts BELOW ObjectId hex under text
    // collation, so an id-ordered re-chain produces a different (wrong) chain
    // here — while a same-shape fixture cannot tell the two apart.
    const root = await seedFanRoot(AUTHOR);
    const first = await seedThreadPost(AUTHOR, {
      id: '65fdc8c8c8c8c8c8c8c8c8f1',
      parentPostId: root.id,
      threadId: root.id,
      createdAt: minute(1),
    });
    const second = await seedThreadPost(AUTHOR, {
      id: '019616a0-0000-7000-8000-0000000000f2',
      parentPostId: root.id,
      threadId: root.id,
      createdAt: minute(2),
    });
    const third = await seedThreadPost(AUTHOR, {
      id: '019616a0-0000-7000-8000-0000000000f3',
      parentPostId: root.id,
      threadId: root.id,
      createdAt: minute(3),
    });

    await migrateThreadFanToChain();

    const parents = await parentsOf([first.id, second.id, third.id]);
    expect(parents.get(first.id)).toBe(root.id);
    expect(parents.get(second.id)).toBe(first.id);
    expect(parents.get(third.id)).toBe(second.id);
  });

  it('is idempotent — a second run re-links nothing', async () => {
    const { continuationIds } = await seedFan({ count: 3 });
    await migrateThreadFanToChain();
    const first = await parentsOf(continuationIds);

    await migrateThreadFanToChain();

    // A repaired thread is a chain, so it no longer satisfies the pure-fan
    // `HAVING` and never reaches the write path again.
    expect(await parentsOf(continuationIds)).toEqual(first);
  });

  it('leaves a 1-continuation thread alone — it is already a correct chain', async () => {
    const { rootId, continuationIds } = await seedFan({ count: 1 });

    await migrateThreadFanToChain();

    expect((await parentsOf(continuationIds)).get(continuationIds[0])).toBe(rootId);
  });

  it('skips a MULTI-AUTHOR thread', async () => {
    const { rootId, continuationIds } = await seedFan({
      count: 3,
      continuationAuthors: [AUTHOR, OTHER, AUTHOR],
    });

    await migrateThreadFanToChain();

    // Every continuation still points at the root: nothing was re-chained.
    const parents = await parentsOf(continuationIds);
    for (const id of continuationIds) expect(parents.get(id)).toBe(rootId);
  });

  it('skips a thread whose root belongs to SOMEBODY ELSE (a reply tree)', async () => {
    const { rootId, continuationIds } = await seedFan({
      count: 3,
      author: OTHER,
      continuationAuthors: [AUTHOR, AUTHOR, AUTHOR],
    });

    await migrateThreadFanToChain();

    const parents = await parentsOf(continuationIds);
    for (const id of continuationIds) expect(parents.get(id)).toBe(rootId);
  });

  it('skips a PARTIALLY CHAINED thread rather than guessing a linear order', async () => {
    // One member already points at a sibling rather than the root, so the group
    // is not a pure fan. That is the interrupted-run state, and the safe
    // direction is to leave it — a wrong linear re-chain is unrecoverable.
    const root = await seedFanRoot(AUTHOR);
    const first = await seedThreadPost(AUTHOR, {
      parentPostId: root.id,
      threadId: root.id,
      createdAt: minute(1),
    });
    const second = await seedThreadPost(AUTHOR, {
      parentPostId: first.id,
      threadId: root.id,
      createdAt: minute(2),
    });
    const third = await seedThreadPost(AUTHOR, {
      parentPostId: root.id,
      threadId: root.id,
      createdAt: minute(3),
    });

    await migrateThreadFanToChain();

    const parents = await parentsOf([first.id, second.id, third.id]);
    expect(parents.get(first.id)).toBe(root.id);
    expect(parents.get(second.id)).toBe(first.id);
    expect(parents.get(third.id)).toBe(root.id);
  });

  it('never re-links a FEDERATED member, and chains the native ones around it', async () => {
    // Federated posts are excluded from the candidate GROUP, not treated as
    // disqualifying the thread — a federated post was never a `createThread`
    // continuation, so its parent link is not this script's to rewrite. The
    // remaining native members are still a pure single-author fan and are
    // repaired among themselves.
    const { rootId, continuationIds } = await seedFan({
      count: 3,
      continuationOverrides: [
        {},
        { federation: { activityId: `https://${scope.name}.test/activities/1` } },
        {},
      ],
    });

    await migrateThreadFanToChain();

    const parents = await parentsOf(continuationIds);
    expect(parents.get(continuationIds[0])).toBe(rootId);
    expect(parents.get(continuationIds[1])).toBe(rootId);
    expect(parents.get(continuationIds[2])).toBe(continuationIds[0]);
  });

  it('skips a thread whose ROOT is federated', async () => {
    // Root ownership is verified against NATIVE roots only, so a federated root
    // resolves to no author and the thread fails the ownership check rather than
    // being re-chained under a post this script does not own.
    const { rootId, continuationIds } = await seedFan({
      count: 3,
      root: { federation: { activityId: `https://${scope.name}.test/activities/2` } },
    });

    await migrateThreadFanToChain();

    const parents = await parentsOf(continuationIds);
    for (const id of continuationIds) expect(parents.get(id)).toBe(rootId);
  });

  it('can no longer repair a fan whose root was already stamped with a threadId', async () => {
    // An OPERATIONAL ORDERING CONSTRAINT, not a bug in either script, and the
    // only place it is written down. `backfillThreadRootThreadId` stamps
    // `thread_id = <own id>` on a self-thread root; that root then joins its own
    // group carrying a NULL `parent_post_id` against a non-null `thread_id`,
    // which is one non-fan member, and the `HAVING … = 0` gate drops the thread
    // for good. So the fan repair has to run FIRST — afterwards there is nothing
    // that can put a stamped fan back together.
    const root = await seedThreadPost(AUTHOR, { threadId: undefined });
    const first = await seedThreadPost(AUTHOR, {
      parentPostId: root.id,
      threadId: root.id,
      createdAt: minute(1),
    });
    const second = await seedThreadPost(AUTHOR, {
      parentPostId: root.id,
      threadId: root.id,
      createdAt: minute(2),
    });
    // What the root-stamping one-shot would have done to this root.
    await getDb().update(posts).set({ threadId: root.id }).where(eq(posts.id, root.id));

    await migrateThreadFanToChain();

    const parents = await parentsOf([first.id, second.id]);
    expect(parents.get(first.id)).toBe(root.id);
    expect(parents.get(second.id)).toBe(root.id);
  });

  it('writes nothing in DRY_RUN mode', async () => {
    // `DRY_RUN` is read once at module load, so the script is re-imported with
    // the env set.
    const { rootId, continuationIds } = await seedFan({ count: 3 });

    vi.stubEnv('DRY_RUN', 'true');
    vi.resetModules();
    const { default: dryRunMigrate } = await import('../../scripts/migrateThreadFanToChain');
    // The reset gives the re-imported script a FRESH `db/postgres`, whose pool
    // this file's `afterAll` cannot reach. `PG_MAX_POOL_SIZE` is 8 per file
    // against one server, so a leaked pool surfaces as a `CONNECT_TIMEOUT` in
    // some other file.
    const freshPostgres = await import('../../db/postgres');
    try {
      await dryRunMigrate();
    } finally {
      await freshPostgres.closePostgres();
      vi.unstubAllEnvs();
      vi.resetModules();
    }

    const parents = await parentsOf(continuationIds);
    for (const id of continuationIds) expect(parents.get(id)).toBe(rootId);
  });
});
