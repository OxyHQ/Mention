/**
 * The self-thread root `threadId` repair, against REAL ROWS.
 *
 * The previous version mocked `Post.aggregate` and fed the script a canned list
 * of "candidate thread groups" — so the half of the script that decides WHICH
 * threads are candidates (a `GROUP BY thread_id` with
 * `HAVING count(distinct oxy_user_id) = 1`, over native posts only) was never
 * executed. That grouping is the safety gate: it is what separates a self-thread
 * from a reply tree, and stamping the root of a reply tree folds an unrelated
 * author's posts into one connected slice.
 *
 * Both halves run for real here. Every case seeds the thread it is about and
 * asserts the stored `thread_id` of the root afterwards.
 *
 * ## Two things the port changed, stated rather than silently dropped
 *
 * `array_agg(distinct …)` DROPS NULLs, so an author-less group aggregates to an
 * EMPTY array — which is why the `HAVING` is `= 1` and not `<= 1`. And the
 * "root missing" guard is no longer reachable: `thread_id` is a real foreign key
 * with `ON DELETE SET NULL`, so a continuation cannot point at a root that does
 * not exist. The guard stays correct and is simply unreachable, which is a
 * better state than the Mongo one it replaces.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import type { PostRecord, PostRecordInput } from '../../db/posts/postRecord';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import backfillThreadRootThreadId from '../../scripts/backfillThreadRootThreadId';

const scope = postScope('backfill-thread-root');
const AUTHOR = scope.user('author');
const OTHER = scope.user('other');

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
 * A root plus `continuations` posts that already carry `threadId = root.id`.
 *
 * The root's own `threadId` is left NULL — the broken shape the repair exists
 * for, and the reason the group's author set describes the continuations only.
 */
async function seedBrokenThread(options: {
  rootAuthor?: string;
  continuationAuthor?: string;
  root?: Partial<PostRecordInput>;
  continuations?: number;
} = {}): Promise<string> {
  const root = await seedThreadPost(options.rootAuthor ?? AUTHOR, options.root);
  for (let i = 0; i < (options.continuations ?? 2); i += 1) {
    await seedThreadPost(options.continuationAuthor ?? AUTHOR, {
      parentPostId: root.id,
      threadId: root.id,
    });
  }
  return root.id;
}

/** The root's stored `thread_id` and `updated_at`. */
async function rootState(id: string) {
  const [row] = await getDb()
    .select({ threadId: posts.threadId, updatedAt: posts.updatedAt })
    .from(posts)
    .where(eq(posts.id, id));
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.stubEnv('CONFIRM_ADMIN_MUTATION', 'backfillThreadRootThreadId');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('backfillThreadRootThreadId', () => {
  it('stamps threadId = its own id on a native single-author self-thread root', async () => {
    const rootId = await seedBrokenThread();
    expect((await rootState(rootId))?.threadId).toBeNull();

    await backfillThreadRootThreadId();

    expect((await rootState(rootId))?.threadId).toBe(rootId);
  });

  it('is idempotent: a root that already carries a threadId is not re-written', async () => {
    const rootId = await seedBrokenThread();
    await backfillThreadRootThreadId();
    const first = await rootState(rootId);

    await backfillThreadRootThreadId();
    const second = await rootState(rootId);

    // `updated_at` is maintained on every `db.update()`, so an unchanged stamp is
    // the evidence that the second run issued no write at all.
    expect(second?.updatedAt).toEqual(first?.updatedAt);
    expect(second?.threadId).toBe(rootId);
  });

  it('skips a REPLY TREE — continuations by an author other than the root’s', async () => {
    // The single continuation author is OTHER while the root belongs to AUTHOR:
    // "someone replied under my post N times", not a self-thread. Stamping this
    // root would fold two people's posts into one connected slice.
    const rootId = await seedBrokenThread({ continuationAuthor: OTHER });

    await backfillThreadRootThreadId();

    expect((await rootState(rootId))?.threadId).toBeNull();
  });

  it('skips a thread whose continuations have TWO distinct authors', async () => {
    // The `HAVING count(distinct …) = 1` gate. A group this mixed is a
    // conversation, and the aggregation is the only thing that can see it.
    const root = await seedThreadPost(AUTHOR);
    await seedThreadPost(AUTHOR, { parentPostId: root.id, threadId: root.id });
    await seedThreadPost(OTHER, { parentPostId: root.id, threadId: root.id });

    await backfillThreadRootThreadId();

    expect((await rootState(root.id))?.threadId).toBeNull();
  });

  it('skips a FEDERATED root', async () => {
    // Federated threads are structured by `inReplyTo`, not `threadId`; the bug
    // and its forward fix are native-`createThread` only.
    const rootId = await seedBrokenThread({
      root: { federation: { activityId: `https://${scope.name}.test/activities/1` } },
    });

    await backfillThreadRootThreadId();

    expect((await rootState(rootId))?.threadId).toBeNull();
  });

  it('skips a thread whose CONTINUATIONS are federated', async () => {
    // The candidate query is restricted to native members. A federated
    // continuation must not put its root in the candidate set at all.
    const root = await seedThreadPost(AUTHOR);
    await seedThreadPost(AUTHOR, {
      parentPostId: root.id,
      threadId: root.id,
      federation: { activityId: `https://${scope.name}.test/activities/2` },
    });

    await backfillThreadRootThreadId();

    expect((await rootState(root.id))?.threadId).toBeNull();
  });

  it('skips a root that is itself a REPLY', async () => {
    const parent = await seedThreadPost(AUTHOR);
    const rootId = await seedBrokenThread({ root: { parentPostId: parent.id } });

    await backfillThreadRootThreadId();

    expect((await rootState(rootId))?.threadId).toBeNull();
  });

  it('writes nothing in DRY_RUN mode', async () => {
    // `DRY_RUN` is read once at module load, so the script is re-imported with
    // the env set — reading it per call would be a different script.
    const rootId = await seedBrokenThread();

    vi.stubEnv('DRY_RUN', 'true');
    vi.resetModules();
    const { default: dryRunBackfill } = await import('../../scripts/backfillThreadRootThreadId');
    // The reset gives the re-imported script a FRESH `db/postgres`, so its
    // `connectPostgres()` opens a second pool that this file's `afterAll` — bound
    // to the original module instance — cannot reach. `PG_MAX_POOL_SIZE` is 8 per
    // file against one server, so a leaked pool is a `CONNECT_TIMEOUT` in some
    // other file, which is the worst possible place for it to surface.
    const freshPostgres = await import('../../db/postgres');
    try {
      await dryRunBackfill();
    } finally {
      await freshPostgres.closePostgres();
      vi.unstubAllEnvs();
      vi.resetModules();
    }

    expect((await rootState(rootId))?.threadId).toBeNull();
  });
});
