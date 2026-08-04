/**
 * The MTN chain store, against real rows.
 *
 * The suite this replaces asserted that a Mongoose query object had been BUILT
 * with a particular filter — `expect(findOne).toHaveBeenCalledWith({...})`. That
 * can only ever restate the implementation, and it is exactly why none of the
 * three things below was covered: a filter shape assertion cannot tell you
 * whether the row that came back is the right one.
 *
 * **The chain.** `prev` + the head pointer ARE the chain; nothing else in the
 * system re-derives them. A record whose `prev` does not name its predecessor,
 * or a head that does not advance, breaks continuity for every later append —
 * and the protocol engine's continuity check reads BOTH from this store, so a
 * store that silently drops one makes the engine approve a chain that is not one.
 *
 * **`chain_status IS NULL` is canonical.** Mongo's `{$ne: 'conflict'}` matched a
 * document with the field absent; SQL's `<> 'conflict'` does NOT match NULL. A
 * literal translation therefore hides every row written before fork
 * classification existed — from `getHead`, from the log, from the cursor — with
 * no error anywhere. Three cases below fail if `canonicalChainRow` loses its
 * `IS NULL` arm.
 *
 * **A duplicate key means retry.** The unique `(oxy_user_id, seq)` index IS the
 * multi-writer race guard: the loser must see `chain_conflict` and re-read the
 * head. Asserted against the real index, because a SQLSTATE predicate that reads
 * `error.code` instead of walking drizzle's `cause` chain matches nothing and
 * turns the loser's duplicate into an unhandled 500.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

import { closePostgres, connectPostgres, type Database } from '../../../db/postgres';
import { mentionRepoHeads, mentionSignedRecords } from '../../../db/schema/mtn';
import {
  MTN_CHAIN_STATUS,
  MentionRecordStoreImpl,
} from '../../../services/mtn/MentionRecordStore';
import { buildUserDid } from '../../../services/mtn/mentionDid';

let db: Database;
const store = new MentionRecordStoreImpl();
const createdUserIds: string[] = [];

/**
 * `record_id` is a GLOBALLY unique content address, and vitest runs test FILES in
 * parallel workers against ONE database — so a fixed `record-0` here collides with
 * another file's `record-0` and fails an insert that has nothing to do with what
 * is under test. Every literal id in this file is namespaced per run.
 */
const NAMESPACE = `store-${randomUUID().slice(0, 8)}`;
function R(name: string): string {
  return `${NAMESPACE}-${name}`;
}

/** An Oxy account id unique to one test, so chains cannot leak between them. */
function chainOwner(): string {
  const id = `oxy-mtn-${randomUUID()}`;
  createdUserIds.push(id);
  return id;
}

/**
 * A v2 envelope for `owner`'s chain. Deliberately hand-built rather than signed:
 * `append` is the STORAGE half and performs no verification — the protocol engine
 * owns that, and mixing the two would make a storage regression look like a
 * signature failure.
 */
function envelopeV2(
  owner: string,
  overrides: Partial<SignedRecordEnvelope> & { seq: number; prev: string | null },
): SignedRecordEnvelope {
  return {
    version: 2,
    type: 'app_record',
    subject: buildUserDid(owner),
    issuer: 'did:web:mention.earth',
    record: { text: 'hello' },
    issuedAt: 1_700_000_000_000,
    collection: 'app.mention.feed.post',
    rkey: 'post-1',
    publicKey: '04abc',
    alg: 'ES256K-DER-SHA256',
    signature: 'signature',
    ...overrides,
  } as SignedRecordEnvelope;
}

async function readRecord(owner: string, recordId: string) {
  const [row] = await db
    .select()
    .from(mentionSignedRecords)
    .where(
      and(
        eq(mentionSignedRecords.oxyUserId, owner),
        eq(mentionSignedRecords.recordId, recordId),
      ),
    )
    .limit(1);
  return row;
}

async function readHead(owner: string) {
  const [row] = await db
    .select()
    .from(mentionRepoHeads)
    .where(eq(mentionRepoHeads.oxyUserId, owner))
    .limit(1);
  return row;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  while (createdUserIds.length > 0) {
    const owner = createdUserIds.pop();
    if (!owner) continue;
    await db.delete(mentionSignedRecords).where(eq(mentionSignedRecords.oxyUserId, owner));
    await db.delete(mentionRepoHeads).where(eq(mentionRepoHeads.oxyUserId, owner));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('append — the record row and the head advance', () => {
  it('persists every envelope field verbatim and opens the chain at seq 0', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    const envelope = envelopeV2(owner, { seq: 0, prev: null, rkey: 'post-genesis' });

    const outcome = await store.append(subject, envelope, R(`record-0`));

    expect(outcome).toEqual({ ok: true, recordId: R(`record-0`), seq: 0 });

    const row = await readRecord(owner, R(`record-0`));
    expect(row).toBeDefined();
    expect(row?.subjectDid).toBe(subject);
    expect(row?.type).toBe('app_record');
    expect(row?.publicKey).toBe('04abc');
    expect(row?.verified).toBe(true);
    expect(row?.seq).toBe(0);
    expect(row?.prev).toBeNull();
    expect(row?.chainStatus).toBe(MTN_CHAIN_STATUS.CANONICAL);
    expect(row?.nsid).toBe('app.mention.feed.post');
    expect(row?.rkey).toBe('post-genesis');
    expect(row?.idempotencyKey).toBeNull();
    // The envelope round-trips through jsonb: verification re-canonicalizes from
    // the PARSED value, so key order does not matter but content must be exact.
    expect(row?.envelope).toEqual(envelope);

    const head = await readHead(owner);
    expect(head?.seq).toBe(0);
    expect(head?.headRecordId).toBe(R(`record-0`));
    expect(head?.recordCount).toBe(1);
    expect(head?.subjectDid).toBe(subject);
  });

  it('links each record to its predecessor and moves the head forward', async () => {
    // THE chain test. `prev` and the head are the only two things that make the
    // ledger a chain; if the append writes a null `prev`, or leaves the head at
    // the genesis record, this is what goes red.
    const owner = chainOwner();
    const subject = buildUserDid(owner);

    await store.append(subject, envelopeV2(owner, { seq: 0, prev: null }), R(`record-0`));
    await store.append(subject, envelopeV2(owner, { seq: 1, prev: R(`record-0`) }), R(`record-1`));
    await store.append(subject, envelopeV2(owner, { seq: 2, prev: R(`record-1`) }), R(`record-2`));

    const second = await readRecord(owner, R(`record-1`));
    const third = await readRecord(owner, R(`record-2`));
    expect(second?.prev).toBe(R(`record-0`));
    expect(third?.prev).toBe(R(`record-1`));

    const head = await readHead(owner);
    expect(head?.headRecordId).toBe(R(`record-2`));
    expect(head?.seq).toBe(2);
    expect(head?.recordCount).toBe(3);

    await expect(store.getHead(subject)).resolves.toEqual({
      headRecordId: R(`record-2`),
      seq: 2,
      recordCount: 3,
    });
  });

  it('reports chain_conflict when another writer already took this seq', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    await store.append(subject, envelopeV2(owner, { seq: 0, prev: null }), R(`record-0`));

    // A concurrent writer that read the same head builds the same seq with a
    // DIFFERENT content address. The unique `(oxy_user_id, seq)` index rejects it.
    const outcome = await store.append(
      subject,
      envelopeV2(owner, { seq: 0, prev: null, record: { text: 'racer' } }),
      R(`record-0-racer`),
    );

    expect(outcome).toEqual({ ok: false, reason: 'chain_conflict' });
    // The losing append must leave NOTHING behind — not the record, and not a
    // head advanced past a record that was never written.
    expect(await readRecord(owner, R(`record-0-racer`))).toBeUndefined();
    const head = await readHead(owner);
    expect(head?.headRecordId).toBe(R(`record-0`));
    expect(head?.recordCount).toBe(1);
  });

  it('reports chain_conflict when the same content address is re-appended', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    await store.append(subject, envelopeV2(owner, { seq: 0, prev: null }), R(`record-0`));

    const outcome = await store.append(
      subject,
      envelopeV2(owner, { seq: 1, prev: R(`record-0`) }),
      R(`record-0`),
    );
    expect(outcome).toEqual({ ok: false, reason: 'chain_conflict' });
  });

  it('stores a v1 envelope unchained and advances no head', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    const envelope = {
      version: 1,
      type: 'profile',
      subject,
      issuer: 'did:web:mention.earth',
      record: { displayName: 'legacy' },
      issuedAt: 1_700_000_000_000,
      publicKey: '04abc',
      alg: 'ES256K-DER-SHA256',
      signature: 'signature',
    } as SignedRecordEnvelope;

    await expect(store.append(subject, envelope, R(`v1-record`))).resolves.toEqual({
      ok: true,
      recordId: R(`v1-record`),
      seq: -1,
    });

    // A v1 row carries NO content address either — the caller's `recordId` is
    // reported back but never denormalized, exactly as the Mongoose path did.
    const [row] = await db
      .select()
      .from(mentionSignedRecords)
      .where(eq(mentionSignedRecords.oxyUserId, owner))
      .limit(1);
    expect(row?.recordId).toBeNull();
    expect(row?.seq).toBeNull();
    expect(row?.prev).toBeNull();
    expect(row?.nsid).toBeNull();
    expect(row?.rkey).toBeNull();
    expect(await readHead(owner)).toBeUndefined();
  });

  it('refuses a subject DID that names no user', async () => {
    const owner = chainOwner();
    await expect(
      store.append('did:web:example.com:not-a-user', envelopeV2(owner, { seq: 0, prev: null }), 'x'),
    ).resolves.toEqual({ ok: false, reason: 'chain_gap' });
  });

  it('refuses a v2 envelope with no numeric seq', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    const malformed = { ...envelopeV2(owner, { seq: 0, prev: null }), seq: undefined } as unknown as SignedRecordEnvelope;
    await expect(store.append(subject, malformed, R(`record-x`))).resolves.toEqual({
      ok: false,
      reason: 'bad_seq',
    });
    expect(await readRecord(owner, R(`record-x`))).toBeUndefined();
  });
});

describe('the durable producer event', () => {
  it('stores the key with the record and resolves the committed append', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    const envelope = envelopeV2(owner, { seq: 0, prev: null, collection: 'app.mention.feed.like', rkey: 'relation-1' });
    const idempotencyKey = 'engagement:post.like:relation-1:v1';

    await expect(
      store.withIdempotencyKey(idempotencyKey).append(subject, envelope, R(`record-1`)),
    ).resolves.toEqual({ ok: true, recordId: R(`record-1`), seq: 0 });

    expect((await readRecord(owner, R(`record-1`)))?.idempotencyKey).toBe(idempotencyKey);
    await expect(store.findByIdempotencyKey(subject, idempotencyKey)).resolves.toEqual({
      recordId: R(`record-1`),
      seq: 0,
      envelope,
    });
  });

  it('reports chain_conflict when the same event key was already committed', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    const key = 'engagement:post.like:relation-1:v1';
    await store.withIdempotencyKey(key).append(subject, envelopeV2(owner, { seq: 0, prev: null }), R(`record-0`));

    // A redelivered producer event, built against the same head.
    const outcome = await store
      .withIdempotencyKey(key)
      .append(subject, envelopeV2(owner, { seq: 1, prev: R(`record-0`) }), R(`record-1`));

    expect(outcome).toEqual({ ok: false, reason: 'chain_conflict' });
    // …and the caller resolves the winner rather than double-writing.
    await expect(store.findByIdempotencyKey(subject, key)).resolves.toMatchObject({
      recordId: R(`record-0`),
    });
  });

  it("recovers a fork archive's seq from its immutable envelope", async () => {
    // A conflict archive carries NO denormalized seq (it is deliberately off the
    // linear chain), so the seq has to come back out of the signed envelope.
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    const envelope = envelopeV2(owner, { seq: 4, prev: R(`record-3`) });
    await db.insert(mentionSignedRecords).values({
      subjectDid: subject,
      oxyUserId: owner,
      type: envelope.type,
      envelope,
      publicKey: envelope.publicKey,
      verified: true,
      chainStatus: MTN_CHAIN_STATUS.CONFLICT,
      recordId: R(`archived-record`),
      idempotencyKey: 'event-1',
      nsid: 'app.mention.feed.post',
      rkey: 'post-1',
    });

    await expect(store.findByIdempotencyKey(subject, 'event-1')).resolves.toEqual({
      recordId: R(`archived-record`),
      seq: 4,
      envelope,
    });
  });

  it('resolves nothing for an unknown event key', async () => {
    const owner = chainOwner();
    await expect(
      store.findByIdempotencyKey(buildUserDid(owner), 'never-written'),
    ).resolves.toBeNull();
  });
});

describe('canonical selection — a NULL chain_status is canonical', () => {
  it('accepts a head whose record predates fork classification', async () => {
    // THE `$ne` regression. `chain_status <> 'conflict'` is NULL for this row, so
    // a literal translation of Mongo's `$ne` drops it and `getHead` throws
    // "inconsistent canonical head" for every user whose chain predates the
    // column — i.e. all of them.
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    await db.insert(mentionSignedRecords).values({
      subjectDid: subject,
      oxyUserId: owner,
      type: 'app_record',
      envelope: envelopeV2(owner, { seq: 2, prev: R(`record-1`) }),
      publicKey: '04abc',
      verified: true,
      seq: 2,
      prev: R(`record-1`),
      recordId: R(`record-2`),
      chainStatus: null,
      nsid: 'app.mention.feed.post',
      rkey: 'post-1',
    });
    await db.insert(mentionRepoHeads).values({
      oxyUserId: owner,
      subjectDid: subject,
      seq: 2,
      headRecordId: R(`record-2`),
      recordCount: 3,
    });

    await expect(store.getHead(subject)).resolves.toEqual({
      headRecordId: R(`record-2`),
      seq: 2,
      recordCount: 3,
    });
  });

  it('fails closed when the head points at a fork archive', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    await db.insert(mentionSignedRecords).values({
      subjectDid: subject,
      oxyUserId: owner,
      type: 'app_record',
      envelope: envelopeV2(owner, { seq: 2, prev: R(`record-1`) }),
      publicKey: '04abc',
      verified: true,
      seq: 2,
      prev: R(`record-1`),
      recordId: R(`record-2`),
      chainStatus: MTN_CHAIN_STATUS.CONFLICT,
    });
    await db.insert(mentionRepoHeads).values({
      oxyUserId: owner,
      subjectDid: subject,
      seq: 2,
      headRecordId: R(`record-2`),
      recordCount: 3,
    });

    await expect(store.getHead(subject)).rejects.toThrow('inconsistent canonical head');
  });

  it('has no head at all for a user who has never appended', async () => {
    await expect(store.getHead(buildUserDid(chainOwner()))).resolves.toBeNull();
  });
});

describe('log and cursor reads', () => {
  it('returns the ordered slice after a seq, keeping legacy rows and dropping forks', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    await store.append(subject, envelopeV2(owner, { seq: 0, prev: null, record: { text: 'zero' } }), R(`record-0`));
    await store.append(subject, envelopeV2(owner, { seq: 1, prev: R(`record-0`), record: { text: 'one' } }), R(`record-1`));
    await store.append(subject, envelopeV2(owner, { seq: 2, prev: R(`record-1`), record: { text: 'two' } }), R(`record-2`));
    // A legacy row (no chain_status) at seq 3 and a fork archive at seq 4.
    await db.insert(mentionSignedRecords).values([
      {
        subjectDid: subject,
        oxyUserId: owner,
        type: 'app_record',
        envelope: envelopeV2(owner, { seq: 3, prev: R(`record-2`), record: { text: 'legacy' } }),
        publicKey: '04abc',
        verified: true,
        seq: 3,
        prev: R(`record-2`),
        recordId: R(`record-3`),
        chainStatus: null,
      },
      {
        subjectDid: subject,
        oxyUserId: owner,
        type: 'app_record',
        envelope: envelopeV2(owner, { seq: 4, prev: R(`record-3`), record: { text: 'fork' } }),
        publicKey: '04abc',
        verified: true,
        seq: 4,
        prev: R(`record-3`),
        recordId: R(`record-4`),
        chainStatus: MTN_CHAIN_STATUS.CONFLICT,
      },
    ]);

    const log = await store.getLogSince(subject, 0, 100);
    expect(log.map((envelope) => envelope.record)).toEqual([
      { text: 'one' },
      { text: 'two' },
      { text: 'legacy' },
    ]);
  });

  it('honours the limit and its ceiling', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    for (let seq = 0; seq < 4; seq += 1) {
      await store.append(
        subject,
        envelopeV2(owner, { seq, prev: seq === 0 ? null : R(`record-${seq - 1}`), record: { text: String(seq) } }),
        R(`record-${seq}`),
      );
    }

    await expect(store.getLogSince(subject, -1, 2)).resolves.toHaveLength(2);
    // A zero/NaN limit falls back to the default rather than returning nothing.
    await expect(store.getLogSince(subject, -1, 0)).resolves.toHaveLength(4);
  });

  it('resolves a cursor recordId to its seq, and refuses a fork archive', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    await store.append(subject, envelopeV2(owner, { seq: 0, prev: null }), R(`record-0`));
    await db.insert(mentionSignedRecords).values({
      subjectDid: subject,
      oxyUserId: owner,
      type: 'app_record',
      envelope: envelopeV2(owner, { seq: 1, prev: R(`record-0`) }),
      publicKey: '04abc',
      verified: true,
      seq: 1,
      prev: R(`record-0`),
      recordId: R(`fork-1`),
      chainStatus: MTN_CHAIN_STATUS.CONFLICT,
    });

    await expect(store.resolveCursorSeq(subject, R(`record-0`))).resolves.toBe(0);
    await expect(store.resolveCursorSeq(subject, R(`fork-1`))).resolves.toBeNull();
    await expect(store.resolveCursorSeq(subject, 'nope')).resolves.toBeNull();
  });
});

describe('per-key materialization keeps fork archives eligible', () => {
  it('serves the newest record for a key even when it is off the linear chain', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    const chained = envelopeV2(owner, { seq: 0, prev: null, issuedAt: 10, record: { text: 'chained' } });
    await store.append(subject, chained, R(`record-0`));

    const fork = envelopeV2(owner, { seq: 1, prev: R(`record-0`), issuedAt: 42, record: { text: 'fork' } });
    await db.insert(mentionSignedRecords).values({
      subjectDid: subject,
      oxyUserId: owner,
      type: 'app_record',
      envelope: fork,
      publicKey: '04abc',
      verified: true,
      recordId: R(`fork-1`),
      chainStatus: MTN_CHAIN_STATUS.CONFLICT,
      nsid: 'app.mention.feed.post',
      rkey: 'post-1',
      // Later than the chained row, so it is the current value for the key.
      createdAt: new Date(Date.now() + 1000),
    });

    await expect(
      store.materializeCurrent(subject, 'app.mention.feed.post', 'post-1'),
    ).resolves.toEqual(fork);
    await expect(store.latestIssuedAtForKey(subject, fork)).resolves.toBe(42);
  });

  it('scopes the monotonicity frontier to ONE key, not the whole chain', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    await store.append(
      subject,
      envelopeV2(owner, { seq: 0, prev: null, issuedAt: 900, rkey: 'post-other' }),
      R(`record-0`),
    );

    // A first append on a DIFFERENT key must see no frontier at all — otherwise a
    // valid record is rejected as a replay because an unrelated key is newer.
    const incoming = envelopeV2(owner, { seq: 1, prev: R(`record-0`), issuedAt: 100, rkey: 'post-new' });
    await expect(store.latestIssuedAtForKey(subject, incoming)).resolves.toBeNull();
  });

  it('treats a v2 envelope with no record key as having no frontier', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    await store.append(subject, envelopeV2(owner, { seq: 0, prev: null }), R(`record-0`));

    const malformed = {
      ...envelopeV2(owner, { seq: 1, prev: R(`record-0`) }),
      collection: undefined,
      rkey: undefined,
    } as unknown as SignedRecordEnvelope;
    await expect(store.latestIssuedAtForKey(subject, malformed)).resolves.toBeNull();
  });

  it('scopes a v1 frontier by envelope type', async () => {
    const owner = chainOwner();
    const subject = buildUserDid(owner);
    const v1 = {
      version: 1,
      type: 'profile',
      subject,
      issuer: 'did:web:mention.earth',
      record: { displayName: 'legacy' },
      issuedAt: 555,
      publicKey: '04abc',
      alg: 'ES256K-DER-SHA256',
      signature: 'signature',
    } as SignedRecordEnvelope;
    await store.append(subject, v1, R(`v1-record`));

    await expect(store.latestIssuedAtForKey(subject, v1)).resolves.toBe(555);
    await expect(
      store.latestIssuedAtForKey(subject, { ...v1, type: 'identity' } as SignedRecordEnvelope),
    ).resolves.toBeNull();
  });
});
