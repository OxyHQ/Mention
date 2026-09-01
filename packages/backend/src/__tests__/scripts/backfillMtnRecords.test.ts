/**
 * The MTN record backfill, against REAL ROWS.
 *
 * The previous version mocked `Post.count/find/findById` over a hand-built
 * array, so the CANDIDATE FILTER never ran — and that filter is the script's
 * whole safety story. Six `IS NULL` / equality arms decide which posts get a
 * signed, permanent chain record; a wrong one either signs a draft into a user's
 * public repo or reports a clean no-op having selected nothing. Neither failure
 * is visible against a mock that hands back whatever the test wrote.
 *
 * So the posts are rows and the filter runs. `emitPostCreated` and
 * `isMentionRecordSigningEnabled` stay mocked: signing needs a key, and the
 * emitter is another module's subject. What the emitter WRITES is real, because
 * the script re-reads `mention_signed_records` afterwards to confirm the append
 * landed — the emitter absorbs its own failures, so that confirmation is the
 * only thing standing between a swallowed append and a run reported as clean.
 *
 * ## This script sweeps the WHOLE corpus, which shapes the file
 *
 * It takes no scope: every local, published, public, non-boost post is a
 * candidate, including rows other files seeded into the shared database. Two
 * consequences, both deliberate:
 *
 *  - Nothing asserts on the run's aggregate counters. Every assertion names a
 *    post this file wrote, and the emission log is filtered to those.
 *  - Cases are GROUPED so the sweep runs a handful of times rather than once per
 *    assertion. A full pass assembles every candidate's nine-table record and
 *    emits for each, so one sweep per assertion is a lot of work for nothing.
 *
 * ## The keyset cursor, and why one case reproduces it without running the sweep
 *
 * This sweep pages on `(created_at, id)` ascending, and it did not terminate on
 * a row whose `created_at` came from the database clock: `timestamptz` carries
 * microseconds, a JS `Date` carries milliseconds, so the cursor compared against
 * a value smaller than the row that produced it and matched its own anchor
 * forever. Fixed at the source — `@oxyhq/db`'s `createdAt()` defaults to
 * `date_trunc('milliseconds', now())`, with a CHECK on `posts` so it cannot come
 * back — and the fixtures here use the database clock again precisely so the
 * ordinary cases exercise it.
 *
 * The last case still reproduces the PREDICATE directly rather than relying on
 * the sweep to hang: a non-terminating sweep can only be observed as a test
 * timeout, which names nothing, and racing it would leave an uncancellable loop
 * hammering the database.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, gt, or } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

/** A full corpus sweep against a database other suites are writing to. */
const SWEEP_TIMEOUT_MS = 60_000;

const h = vi.hoisted(() => {
  const state: {
    signingEnabled: boolean;
    /**
     * What the mocked emitter does with each post it is handed. `write` inserts a
     * real chain row (the success path the confirmation read has to see);
     * `swallow` writes nothing, reproducing the emitter's documented behaviour of
     * absorbing an append failure — which is exactly why the script re-reads.
     */
    emitBehaviour: 'write' | 'swallow';
    /** Every post id the emitter was handed, in order, with its reply context. */
    emitted: Array<{ postId: string; reply: unknown }>;
  } = { signingEnabled: true, emitBehaviour: 'write', emitted: [] };

  const isSigningEnabled = vi.fn(() => state.signingEnabled);

  const emitPostCreated = vi.fn(
    async (post: { id: string }, options?: { reply?: unknown }) => {
      state.emitted.push({ postId: post.id, reply: options?.reply });
      if (state.emitBehaviour === 'write') {
        await writeChainRow(post.id);
      }
    },
  );

  return { state, isSigningEnabled, emitPostCreated };
});

vi.mock('../../services/mtn/mentionRecordEnv', () => ({
  isMentionRecordSigningEnabled: h.isSigningEnabled,
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: h.emitPostCreated,
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { mentionSignedRecords } from '../../db/schema/mtn';
import { posts } from '../../db/schema/posts';
import { findPostRecords } from '../../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../../db/posts/postRecord';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import backfillMtnRecords from '../../scripts/backfill-mtn-records';
import { MENTION_POST_COLLECTION } from '@mention/shared-types';

const scope = postScope('backfill-mtn-records');
const AUTHOR = scope.user('author');

/** The chain owner every row in this suite belongs to, so cleanup is exact. */
const CHAIN_OWNER = 'oxy-backfill-mtn-suite';

/**
 * Write the `app.mention.feed.post` chain row for `postId`. Declared as a function
 * so the hoisted emitter mock can close over it.
 */
async function writeChainRow(postId: string): Promise<void> {
  await getDb().insert(mentionSignedRecords).values({
    subjectDid: `did:web:oxy.so:u:${CHAIN_OWNER}`,
    oxyUserId: CHAIN_OWNER,
    type: 'app_record',
    envelope: {
      version: 2,
      type: 'app_record',
      subject: `did:web:oxy.so:u:${CHAIN_OWNER}`,
      issuer: 'did:web:mention.earth',
      record: { text: 'backfilled', createdAt: '2024-01-01T00:00:00.000Z' },
      issuedAt: 1_700_000_000_000,
      seq: 0,
      prev: null,
      collection: MENTION_POST_COLLECTION,
      rkey: postId,
      publicKey: '04abc',
      alg: 'ES256K-DER-SHA256',
      signature: 'signature',
      // The envelope shape is validated on the write path, never here.
    } as never,
    publicKey: '04abc',
    verified: true,
    recordId: `rid-${postId}`,
    nsid: MENTION_POST_COLLECTION,
    rkey: postId,
  });
}

/**
 * A candidate post: local, published, public, non-boost, with an author.
 *
 * `createdAt` is left to the DATABASE CLOCK on purpose — that is the shape every
 * production row has, and it is the shape that used to hang this sweep (see the
 * last case in this file). While the defect was live these fixtures had to pin
 * an explicit millisecond timestamp to avoid hanging the whole run; letting the
 * default back in is what makes the ordinary cases cover the fix too, rather
 * than leaving one test carrying it alone.
 */
async function seedCandidate(overrides: Partial<PostRecordInput> = {}): Promise<PostRecord> {
  const owner = (overrides.oxyUserId ?? AUTHOR) as string;
  return seedPost(scope, {
    oxyUserId: owner,
    authorship: owner ? [{ oxyUserId: owner, role: 'owner', status: 'accepted' }] : [],
    ...overrides,
  });
}

/** The ids this file seeded, in the order the emitter saw them. */
function emittedAmong(ids: string[]): string[] {
  const wanted = new Set(ids);
  return h.state.emitted.map((entry) => entry.postId).filter((id) => wanted.has(id));
}

/** Whether a chain record exists for `postId`. */
async function hasChainRow(postId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: mentionSignedRecords.id })
    .from(mentionSignedRecords)
    .where(eq(mentionSignedRecords.rkey, postId));
  return row !== undefined;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  vi.stubEnv('CONFIRM_ADMIN_MUTATION', 'backfillMtnRecords');
  h.state.signingEnabled = true;
  h.state.emitBehaviour = 'write';
  h.state.emitted = [];
  h.isSigningEnabled.mockClear();
  h.emitPostCreated.mockClear();
  await getDb().delete(mentionSignedRecords).where(eq(mentionSignedRecords.oxyUserId, CHAIN_OWNER));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await getDb().delete(mentionSignedRecords).where(eq(mentionSignedRecords.oxyUserId, CHAIN_OWNER));
  await clearPostScope(scope);
});

describe('backfillMtnRecords', () => {
  it('is a no-op when MTN signing is disabled (writes no records)', async () => {
    h.state.signingEnabled = false;
    const post = await seedCandidate();

    await backfillMtnRecords();

    // Bailed before scanning: an unsigned record must never be fabricated, and a
    // later run with the key set is what does the real work.
    expect(h.emitPostCreated).not.toHaveBeenCalled();
    expect(await hasChainRow(post.id)).toBe(false);
  });

  it('signs ONLY local, published, public, authored, non-boost posts', async () => {
    // A signed record is permanent and public. Each excluded shape below is one
    // arm of the candidate filter, and each is separately capable of putting
    // content into a user's repo that was never meant to be there. They share
    // one sweep because the sweep is the expensive part, not the seeding.
    const included = await seedCandidate();
    const federated = await seedCandidate({
      federation: { activityId: `https://${scope.name}.test/activities/1` },
    });
    const draft = await seedCandidate({ status: 'draft' });
    const priv = await seedCandidate({ visibility: PostVisibility.PRIVATE });
    const followersOnly = await seedCandidate({ visibility: PostVisibility.FOLLOWERS_ONLY });
    const orphan = await seedCandidate({ oxyUserId: null });
    const boost = await seedCandidate({
      type: PostType.BOOST,
      boostOf: included.id,
      content: { variants: [{ source: 'author', text: '', tag: 'en' }] },
    });
    const excluded = [federated.id, draft.id, priv.id, followersOnly.id, orphan.id, boost.id];

    await backfillMtnRecords();

    expect(emittedAmong([included.id, ...excluded])).toEqual([included.id]);
    for (const id of excluded) {
      expect(await hasChainRow(id), `expected no chain row for ${id}`).toBe(false);
    }
  }, SWEEP_TIMEOUT_MS);

  it('emits for a post lacking a record and skips one that already has one', async () => {
    const needsRecord = await seedCandidate({ createdAt: new Date('2024-01-01T00:00:00Z') });
    const hasRecord = await seedCandidate({ createdAt: new Date('2024-01-02T00:00:00Z') });
    // A REAL chain row for the second post. The skip has to come from the query.
    await writeChainRow(hasRecord.id);

    await backfillMtnRecords();

    expect(emittedAmong([needsRecord.id, hasRecord.id])).toEqual([needsRecord.id]);
    expect(await hasChainRow(needsRecord.id)).toBe(true);
  }, SWEEP_TIMEOUT_MS);

  it('emits oldest-first, with the reply context resolved from real parent and root rows', async () => {
    // Two guarantees, one sweep. Genesis has to be the OLDEST post: the chain is
    // a per-user sequence, and a backfill that appends newest-first produces a
    // repo whose order contradicts the posts it describes. And a backfilled
    // reply record has to be byte-identical to one the live path would emit,
    // which means resolving the parent's and the thread root's OWNERS.
    const rootAuthor = scope.user('root-author');
    const root = await seedCandidate({
      oxyUserId: rootAuthor,
      createdAt: new Date('2024-01-01T00:00:00Z'),
    });
    const parent = await seedCandidate({
      parentPostId: root.id,
      threadId: root.id,
      createdAt: new Date('2024-01-02T00:00:00Z'),
    });
    const reply = await seedCandidate({
      parentPostId: parent.id,
      threadId: root.id,
      createdAt: new Date('2024-01-03T00:00:00Z'),
    });

    await backfillMtnRecords();

    expect(emittedAmong([root.id, parent.id, reply.id])).toEqual([root.id, parent.id, reply.id]);
    expect(h.state.emitted.find((item) => item.postId === root.id)?.reply).toBeUndefined();
    expect(h.state.emitted.find((item) => item.postId === reply.id)?.reply).toEqual({
      root: { postId: root.id, oxyUserId: rootAuthor },
      parent: { postId: parent.id, oxyUserId: AUTHOR },
    });
  }, SWEEP_TIMEOUT_MS);

  it('counts a post as failed when the emitter swallowed the append', async () => {
    // The confirmation read is the ONLY thing that distinguishes a written record
    // from an emitter that absorbed its own failure — `assertAdminRunComplete`
    // then makes the run exit non-zero rather than reporting a clean backfill.
    h.state.emitBehaviour = 'swallow';
    const post = await seedCandidate();

    // The count is not pinned: this file does not own the corpus the sweep
    // visits, and every post in it fails under `swallow`.
    await expect(backfillMtnRecords()).rejects.toThrow(/run incomplete: failed=[1-9]/);
    expect(await hasChainRow(post.id)).toBe(false);
  }, SWEEP_TIMEOUT_MS);

  it('advances its cursor past a post whose createdAt came from the DATABASE CLOCK', async () => {
    // The paging cursor is `(created_at, id)` ascending, carried between pages as
    // the last row's values. `created_at` is `timestamptz` — MICROSECOND
    // precision — and a JS `Date` holds milliseconds, so the round trip TRUNCATES
    // it: a row stored at `…179527` comes back as `…179`, and the next page's
    // `created_at > '…179'` is TRUE for that same row. The cursor never advances
    // and the sweep never terminates.
    //
    // Reproduced with the script's own predicate rather than by running it,
    // deliberately: a non-terminating sweep can only be observed as a test
    // timeout, which names nothing, and racing it would leave an uncancellable
    // loop hammering the database for the rest of the run.
    //
    // Every OTHER fixture in this file pins a millisecond-precision `createdAt`
    // to stay clear of this. `defaultNow()` is what production rows carry.
    const post = await seedPost(scope, {
      oxyUserId: AUTHOR,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    });
    const [record] = await findPostRecords(eq(posts.id, post.id), {
      orderBy: [asc(posts.createdAt), asc(posts.id)],
      limit: 1,
    });

    const nextPage = await findPostRecords(
      and(
        eq(posts.id, post.id),
        or(
          gt(posts.createdAt, record.createdAt),
          and(eq(posts.createdAt, record.createdAt), gt(posts.id, record.id)),
        ),
      ),
      { orderBy: [asc(posts.createdAt), asc(posts.id)], limit: 1 },
    );

    expect(
      nextPage.map((row) => row.id),
      'a keyset cursor taken from a row must EXCLUDE that row from the next page',
    ).toEqual([]);
  });
});
