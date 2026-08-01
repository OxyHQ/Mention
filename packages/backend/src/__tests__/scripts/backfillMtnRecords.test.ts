import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { eq } from 'drizzle-orm';

/**
 * The MTN record backfill.
 *
 * `Post` (count/find/findById), `isMentionRecordSigningEnabled` and
 * `emitPostCreated` are mocked so the REAL candidate selection, ordering and
 * inert-safe bail run without MongoDB or a signing key.
 *
 * **The chain is not mocked.** Both of this script's chain reads — the batched
 * "which of these posts already has a record" skip and the post-emit confirmation
 * — run against real `mention_signed_records` rows. Their previous mocks
 * re-implemented the filter in the test, so an existence check that queried the
 * wrong column would have kept passing; and this script's whole job is deciding
 * what to skip, so a wrong skip is either a duplicate signed record or a post
 * that silently never gets one.
 */

interface PostRow {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
}

const h = vi.hoisted(() => {
  const state: {
    signingEnabled: boolean;
    posts: PostRow[];
    /**
     * What the mocked emitter does with each post it is handed. `write` inserts a
     * real chain row (the success path the confirmation read has to see);
     * `swallow` writes nothing, reproducing the emitter's documented behaviour of
     * absorbing an append failure — which is exactly why the script re-reads.
     */
    emitBehaviour: 'write' | 'swallow';
    /** Every post id the emitter was handed, in order. */
    emittedFor: string[];
  } = { signingEnabled: true, posts: [], emitBehaviour: 'write', emittedFor: [] };

  const countDocuments = vi.fn(async () => state.posts.length);

  // Post.find returns the candidate page on the FIRST cursor read, then an empty
  // page so the script's `for (;;)` paging loop terminates (the real cursor
  // advances past the last (createdAt, _id) and finds nothing more). A query with
  // a `$or` cursor clause is a subsequent page → empty.
  const find = vi.fn((query: Record<string, unknown>) => ({
    sort: () => ({
      limit: () => ({
        lean: async () => (query.$or ? [] : state.posts),
      }),
    }),
  }));

  const findById = vi.fn(async (id: mongoose.Types.ObjectId) => {
    const row = state.posts.find((p) => p._id.toString() === id.toString());
    if (!row) return null;
    return {
      _id: row._id,
      oxyUserId: 'user-A',
      federation: undefined,
      parentPostId: undefined,
      threadId: undefined,
      content: { text: 'a backfilled post body long enough' },
    };
  });

  const isSigningEnabled = vi.fn(() => state.signingEnabled);

  // The emitter is mocked, but what it WRITES is real: the confirmation read the
  // script performs afterwards has to find (or not find) an actual chain row.
  const emitPostCreated = vi.fn(async (post: { _id: mongoose.Types.ObjectId }) => {
    state.emittedFor.push(post._id.toString());
    if (state.emitBehaviour === 'write') {
      await writeChainRow(post._id.toString());
    }
  });

  return {
    state,
    countDocuments,
    find,
    findById,
    isSigningEnabled,
    emitPostCreated,
  };
});

vi.mock('../../models/Post', () => ({
  Post: { countDocuments: h.countDocuments, find: h.find, findById: h.findById },
}));

vi.mock('../../services/mtn/mentionRecordEnv', () => ({
  isMentionRecordSigningEnabled: h.isSigningEnabled,
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: h.emitPostCreated,
}));

vi.mock('../../utils/database', () => ({
  connectToDatabase: vi.fn(async () => undefined),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined as never);

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { mentionSignedRecords } from '../../db/schema/mtn';
import backfillMtnRecords from '../../scripts/backfill-mtn-records';
import { MENTION_POST_COLLECTION } from '@mention/shared-types';

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

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  vi.stubEnv('CONFIRM_ADMIN_MUTATION', 'backfillMtnRecords');
  h.state.signingEnabled = true;
  h.state.posts = [];
  h.state.emitBehaviour = 'write';
  h.state.emittedFor = [];
  h.countDocuments.mockClear();
  h.find.mockClear();
  h.findById.mockClear();
  h.isSigningEnabled.mockClear();
  h.emitPostCreated.mockClear();
  await getDb().delete(mentionSignedRecords).where(eq(mentionSignedRecords.oxyUserId, CHAIN_OWNER));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await getDb().delete(mentionSignedRecords).where(eq(mentionSignedRecords.oxyUserId, CHAIN_OWNER));
});

describe('backfillMtnRecords', () => {
  it('is a no-op when MTN signing is disabled (writes no records)', async () => {
    h.state.signingEnabled = false;
    h.state.posts = [{ _id: new mongoose.Types.ObjectId(), createdAt: new Date() }];

    await backfillMtnRecords();

    // Bailed before scanning — no candidate scan, no emission.
    expect(h.countDocuments).not.toHaveBeenCalled();
    expect(h.emitPostCreated).not.toHaveBeenCalled();
  });

  it('emits a genesis record for a post lacking one and skips posts that already have one', async () => {
    const needsRecord = new mongoose.Types.ObjectId();
    const hasRecord = new mongoose.Types.ObjectId();
    h.state.posts = [
      { _id: needsRecord, createdAt: new Date('2024-01-01T00:00:00Z') },
      { _id: hasRecord, createdAt: new Date('2024-01-02T00:00:00Z') },
    ];
    // A REAL chain row for the second post. The skip has to come from the query.
    await writeChainRow(hasRecord.toString());

    await backfillMtnRecords();

    expect(h.state.emittedFor).toEqual([needsRecord.toString()]);
    // …and the run left exactly one NEW row behind, for the post that lacked one.
    const rows = await getDb()
      .select({ rkey: mentionSignedRecords.rkey })
      .from(mentionSignedRecords)
      .where(eq(mentionSignedRecords.oxyUserId, CHAIN_OWNER));
    expect(rows.map((row) => row.rkey).sort()).toEqual(
      [needsRecord.toString(), hasRecord.toString()].sort(),
    );
  });

  it('counts a post as failed when the emitter swallowed the append', async () => {
    // The confirmation read is the ONLY thing that distinguishes a written record
    // from an emitter that absorbed its own failure — `assertAdminRunComplete`
    // then makes the run exit non-zero rather than reporting a clean backfill.
    h.state.emitBehaviour = 'swallow';
    h.state.posts = [{ _id: new mongoose.Types.ObjectId(), createdAt: new Date('2024-01-01T00:00:00Z') }];

    await expect(backfillMtnRecords()).rejects.toThrow('run incomplete: failed=1');
  });

  it('does nothing when there are no candidate posts', async () => {
    h.state.posts = [];

    await backfillMtnRecords();

    expect(h.emitPostCreated).not.toHaveBeenCalled();
  });
});
