/**
 * The engagement outbox's MTN append, end to end against real rows, on the
 * chain shape that stalled it in production.
 *
 * One account's chain came through the Mongo → Postgres cutover as seq 1..100
 * with neither its seq-0 genesis nor its head row. The first append afterwards
 * found no head and wrote a NEW genesis at seq 0; every append after that built
 * seq 1 and hit the imported seq 1 on the unique `(oxy_user_id, seq)` index. The
 * retry loop re-read the same head each time, so each like event failed with
 * `emitLikeCreated append failed: chain_conflict` — for weeks.
 *
 * Everything here is real: the `@oxy.so/protocol` engine signs and verifies,
 * and `MentionRecordStore` writes Postgres. Only Oxy's DID resolution is mocked,
 * since the subject has no keys of its own and the custodial branch is the one
 * under test.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxy.so/contracts';

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    resolveDid: vi.fn(async () => ({ verificationMethod: [] })),
  }),
}));

import { closePostgres, connectPostgres, type Database } from '../../../db/postgres';
import { mentionRepoHeads, mentionSignedRecords } from '../../../db/schema/mtn';
import { emitLikeCreatedStrict } from '../../../services/mtn/MentionRecordEmitter';
import { MTN_CHAIN_STATUS } from '../../../services/mtn/MentionRecordStore';
import { buildUserDid } from '../../../services/mtn/mentionDid';
import { clearVerificationMethodCache } from '../../../services/mtn/mentionVerificationResolver';

const CUSTODIAL_PRIVATE = 'd6bd0dbca0e4e37f4329e615cde35d1990ff6650d5b88a58c470d6d393cc6584';
const CUSTODIAL_PUBLIC =
  '04d5c06b76d56858b73655c4cc03594cc17e60d1a1607e14b98387bf5dcc62282a66ad2e1eb60b96fb854f1c303b1d50a7eebbcb06ea7151f69b0e2cbc436f43a6';
const MENTION_DID = 'did:web:mention.earth';

let db: Database;
const owners: string[] = [];
const NAMESPACE = `repair-${randomUUID().slice(0, 8)}`;

function chainOwner(): string {
  const id = `oxy-repair-${randomUUID()}`;
  owners.push(id);
  return id;
}

/** A ledger row written straight to the table, as the cutover import did. */
async function importedRow(owner: string, seq: number, prev: string, recordId: string): Promise<void> {
  const envelope = {
    version: 2,
    type: 'app_record',
    subject: buildUserDid(owner),
    issuer: MENTION_DID,
    record: { text: 'imported' },
    issuedAt: 1_751_000_000_000 + seq,
    seq,
    prev,
    collection: 'app.mention.feed.post',
    rkey: `imported-${seq}`,
    publicKey: CUSTODIAL_PUBLIC,
    alg: 'ES256K-DER-SHA256',
    signature: 'imported',
  } as SignedRecordEnvelope;
  await db.insert(mentionSignedRecords).values({
    subjectDid: envelope.subject,
    oxyUserId: owner,
    type: envelope.type,
    envelope,
    publicKey: CUSTODIAL_PUBLIC,
    verified: true,
    seq,
    prev,
    recordId,
    chainStatus: MTN_CHAIN_STATUS.CANONICAL,
    nsid: envelope.collection,
    rkey: envelope.rkey,
  });
}

function like(owner: string, relation: string, createdAt: Date) {
  return {
    likerOxyUserId: owner,
    likeRkey: relation,
    likedPostId: `post-${relation}`,
    likedPostOwnerOxyUserId: 'post-owner',
    idempotencyKey: `engagement:post.like:${relation}:v1`,
    issuedAt: createdAt,
  };
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  process.env.MENTION_DID = MENTION_DID;
  process.env.MENTION_PRIVATE_KEY = CUSTODIAL_PRIVATE;
  process.env.MENTION_PUBLIC_KEY = CUSTODIAL_PUBLIC;
  clearVerificationMethodCache();
});

afterEach(async () => {
  delete process.env.MENTION_DID;
  delete process.env.MENTION_PRIVATE_KEY;
  delete process.env.MENTION_PUBLIC_KEY;
  for (const owner of owners.splice(0)) {
    await db.delete(mentionSignedRecords).where(eq(mentionSignedRecords.oxyUserId, owner));
    await db.delete(mentionRepoHeads).where(eq(mentionRepoHeads.oxyUserId, owner));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('a like on a chain the cutover left inconsistent', () => {
  it('appends, where it used to fail with chain_conflict on every attempt', async () => {
    const owner = chainOwner();
    for (let seq = 1; seq <= 3; seq += 1) {
      await importedRow(
        owner,
        seq,
        seq === 1 ? `${NAMESPACE}-lost-genesis` : `${NAMESPACE}-imported-${seq - 1}`,
        `${NAMESPACE}-imported-${seq}`,
      );
    }
    // The post-cutover genesis: no head existed, so it opened a new chain at 0.
    await emitLikeCreatedStrict(like(owner, `${NAMESPACE}-first`, new Date(Date.now() - 60_000)));

    // The append that failed in production — the outbox retried it ~3,000 times.
    await expect(
      emitLikeCreatedStrict(like(owner, `${NAMESPACE}-second`, new Date(Date.now() - 30_000))),
    ).resolves.toBeUndefined();

    const [head] = await db
      .select()
      .from(mentionRepoHeads)
      .where(eq(mentionRepoHeads.oxyUserId, owner));
    expect(head?.seq).toBe(1);

    const chain = await db
      .select({ seq: mentionSignedRecords.seq, rkey: mentionSignedRecords.rkey })
      .from(mentionSignedRecords)
      .where(and(eq(mentionSignedRecords.oxyUserId, owner), isNotNull(mentionSignedRecords.seq)))
      .orderBy(mentionSignedRecords.seq);
    expect(chain).toEqual([
      { seq: 0, rkey: `${NAMESPACE}-first` },
      { seq: 1, rkey: `${NAMESPACE}-second` },
    ]);

    const archived = await db
      .select({ chainStatus: mentionSignedRecords.chainStatus })
      .from(mentionSignedRecords)
      .where(
        and(
          eq(mentionSignedRecords.oxyUserId, owner),
          eq(mentionSignedRecords.chainStatus, MTN_CHAIN_STATUS.CONFLICT),
        ),
      );
    expect(archived).toHaveLength(3);
  });

  it('treats a redelivered event as the append it already made', async () => {
    const owner = chainOwner();
    await importedRow(owner, 1, `${NAMESPACE}-lost`, `${NAMESPACE}-orphan-${owner}`);
    await emitLikeCreatedStrict(like(owner, `${NAMESPACE}-a`, new Date(Date.now() - 60_000)));
    const event = like(owner, `${NAMESPACE}-b`, new Date(Date.now() - 30_000));

    await emitLikeCreatedStrict(event);
    await emitLikeCreatedStrict(event);

    const keyed = await db
      .select({ seq: mentionSignedRecords.seq })
      .from(mentionSignedRecords)
      .where(
        and(
          eq(mentionSignedRecords.oxyUserId, owner),
          eq(mentionSignedRecords.idempotencyKey, event.idempotencyKey),
        ),
      );
    expect(keyed).toEqual([{ seq: 1 }]);
  });
});
