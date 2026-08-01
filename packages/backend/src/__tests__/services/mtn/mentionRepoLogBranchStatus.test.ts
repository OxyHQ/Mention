/**
 * The PUBLIC log a node export serves, against real rows.
 *
 * The suite this replaces asserted the Mongo filter object and nothing else, so
 * it could not have caught either thing that actually matters here.
 *
 * **The bookmark collection must never leave.** `getPublicLogSince` is the only
 * difference between the node export and the raw chain log; a private collection
 * that slips through is a privacy leak with no error and no symptom.
 *
 * **A legacy row must still export.** The allowlist is combined with the
 * canonical-branch predicate, and `chain_status <> 'conflict'` is NULL — hence
 * false — for every row written before fork classification. If that predicate
 * loses its `IS NULL` arm the export silently stops carrying a user's entire
 * history, and a puller sees an empty repo rather than an error.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import {
  MENTION_BOOKMARK_COLLECTION,
  MENTION_POST_COLLECTION,
  MENTION_TOMBSTONE_COLLECTION,
} from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../../db/postgres';
import { mentionRepoHeads, mentionSignedRecords } from '../../../db/schema/mtn';
import { MTN_CHAIN_STATUS } from '../../../services/mtn/MentionRecordStore';
import { getHead, getPublicLogSince } from '../../../services/mtn/MentionRepoLogService';
import { buildUserDid } from '../../../services/mtn/mentionDid';

let db: Database;
const createdUserIds: string[] = [];

function chainOwner(): string {
  const id = `oxy-publiclog-${randomUUID()}`;
  createdUserIds.push(id);
  return id;
}

function envelope(owner: string, seq: number, collection: string, text: string): SignedRecordEnvelope {
  return {
    version: 2,
    type: 'app_record',
    subject: buildUserDid(owner),
    issuer: 'did:web:mention.earth',
    record: { text },
    issuedAt: 1_700_000_000_000 + seq,
    seq,
    prev: seq === 0 ? null : `${owner}-record-${seq - 1}`,
    collection,
    rkey: `key-${seq}`,
    publicKey: '04abc',
    alg: 'ES256K-DER-SHA256',
    signature: 'signature',
  } as SignedRecordEnvelope;
}

/** Insert a ledger row directly, so a test can pin `chain_status` exactly. */
async function insertRow(
  owner: string,
  seq: number,
  collection: string,
  text: string,
  chainStatus: string | null,
): Promise<void> {
  await db.insert(mentionSignedRecords).values({
    subjectDid: buildUserDid(owner),
    oxyUserId: owner,
    type: 'app_record',
    envelope: envelope(owner, seq, collection, text),
    publicKey: '04abc',
    verified: true,
    seq,
    prev: seq === 0 ? null : `${owner}-record-${seq - 1}`,
    // `record_id` is a GLOBALLY unique content address and vitest runs test FILES
    // in parallel workers against ONE database, so it carries its owner.
    recordId: `${owner}-record-${seq}`,
    chainStatus,
    nsid: collection,
    rkey: `key-${seq}`,
  });
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

describe('getPublicLogSince', () => {
  it('withholds the private bookmark collection', async () => {
    const owner = chainOwner();
    await insertRow(owner, 0, MENTION_POST_COLLECTION, 'a post', MTN_CHAIN_STATUS.CANONICAL);
    await insertRow(owner, 1, MENTION_BOOKMARK_COLLECTION, 'a private bookmark', MTN_CHAIN_STATUS.CANONICAL);
    await insertRow(owner, 2, MENTION_TOMBSTONE_COLLECTION, 'a deletion', MTN_CHAIN_STATUS.CANONICAL);

    const log = await getPublicLogSince(owner, -1, 100);

    // A deletion IS public history; a bookmark is not.
    expect(log.map((row) => row.record)).toEqual([{ text: 'a post' }, { text: 'a deletion' }]);
  });

  it('exports a row written before fork classification existed', async () => {
    const owner = chainOwner();
    await insertRow(owner, 0, MENTION_POST_COLLECTION, 'legacy', null);

    await expect(getPublicLogSince(owner, -1, 100)).resolves.toEqual([
      expect.objectContaining({ record: { text: 'legacy' } }),
    ]);
  });

  it('excludes a fork archive', async () => {
    const owner = chainOwner();
    await insertRow(owner, 0, MENTION_POST_COLLECTION, 'canonical', MTN_CHAIN_STATUS.CANONICAL);
    await insertRow(owner, 1, MENTION_POST_COLLECTION, 'fork', MTN_CHAIN_STATUS.CONFLICT);

    await expect(getPublicLogSince(owner, -1, 100)).resolves.toEqual([
      expect.objectContaining({ record: { text: 'canonical' } }),
    ]);
  });

  it('returns the slice strictly after the cursor, in seq order, capped by the limit', async () => {
    const owner = chainOwner();
    for (let seq = 0; seq < 5; seq += 1) {
      await insertRow(owner, seq, MENTION_POST_COLLECTION, `post-${seq}`, MTN_CHAIN_STATUS.CANONICAL);
    }

    await expect(getPublicLogSince(owner, 2, 100)).resolves.toEqual([
      expect.objectContaining({ record: { text: 'post-3' } }),
      expect.objectContaining({ record: { text: 'post-4' } }),
    ]);
    await expect(getPublicLogSince(owner, -1, 2)).resolves.toEqual([
      expect.objectContaining({ record: { text: 'post-0' } }),
      expect.objectContaining({ record: { text: 'post-1' } }),
    ]);
  });
});

describe('getHead', () => {
  it('reports the subject chain head by oxyUserId', async () => {
    const owner = chainOwner();
    await insertRow(owner, 0, MENTION_POST_COLLECTION, 'only', MTN_CHAIN_STATUS.CANONICAL);
    await db.insert(mentionRepoHeads).values({
      oxyUserId: owner,
      subjectDid: buildUserDid(owner),
      seq: 0,
      headRecordId: `${owner}-record-0`,
      recordCount: 1,
    });

    await expect(getHead(owner)).resolves.toEqual({
      headRecordId: `${owner}-record-0`,
      seq: 0,
      recordCount: 1,
    });
  });

  it('reports no head for a user who has never appended', async () => {
    await expect(getHead(chainOwner())).resolves.toBeNull();
  });
});
