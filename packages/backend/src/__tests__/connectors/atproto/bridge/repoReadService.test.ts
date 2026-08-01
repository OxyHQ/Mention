/**
 * The atproto bridge's repo READ, against real ledger rows.
 *
 * The service projects the CURRENT materialized state of one MTN collection into
 * atproto records: last-writer-wins per rkey, tombstone removal, private
 * collections withheld, pagination by rkey cursor, and a visibility join back to
 * the authoritative `Post`.
 *
 * The ledger is REAL here. The previous suite mocked `MentionSignedRecord.find`
 * and then asserted the Mongo filter object, which meant its two most important
 * cases — "a bookmark never leaves" and "a tombstone removes its key" — were
 * verified against rows the test itself had hand-sorted into the answer. Real
 * rows make the ORDER BY part of what is under test rather than part of the
 * fixture.
 *
 * `Post` stays mocked: the visibility join reads the authoritative post row,
 * which is still Mongo in this phase of the migration.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import {
  MENTION_BOOKMARK_COLLECTION,
  MENTION_POST_COLLECTION,
  MENTION_LIKE_COLLECTION,
  MENTION_TOMBSTONE_COLLECTION,
  createPostUri,
} from '@mention/shared-types';
import { buildUserDid } from '../../../../services/mtn/mentionDid';

const mockPostFind = vi.fn();

vi.mock('../../../../models/Post', () => ({
  Post: { find: (...a: unknown[]) => mockPostFind(...a) },
}));

import { closePostgres, connectPostgres, type Database } from '../../../../db/postgres';
import { mentionSignedRecords } from '../../../../db/schema/mtn';
import { listRecords, getRecord } from '../../../../connectors/atproto/bridge/repoReadService';

let db: Database;
let OWNER = '';
const createdOwners: string[] = [];

interface LedgerSeed {
  nsid: string;
  rkey: string;
  record: Record<string, unknown>;
  createdAt: string;
  recordId?: string;
}

/** Write one denormalized ledger row for the current owner. */
async function seed(rows: LedgerSeed[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(mentionSignedRecords).values(
    rows.map((opts) => ({
      subjectDid: buildUserDid(OWNER),
      oxyUserId: OWNER,
      type: 'app_record',
      envelope: {
        version: 2,
        type: 'app_record',
        subject: buildUserDid(OWNER),
        issuer: 'did:web:mention.earth',
        record: opts.record,
        issuedAt: new Date(opts.createdAt).getTime(),
        collection: opts.nsid,
        rkey: opts.rkey,
      } as SignedRecordEnvelope,
      publicKey: '04abc',
      verified: true,
      recordId: opts.recordId ?? `rid-${opts.rkey}-${new Date(opts.createdAt).getTime()}`,
      nsid: opts.nsid,
      rkey: opts.rkey,
      createdAt: new Date(opts.createdAt),
    })),
  );
}

function postRecord(text: string): Record<string, unknown> {
  return { text, createdAt: '2026-06-30T00:00:00.000Z' };
}

/** The authoritative `Post` join answers with exactly these ids as published+public. */
function publicPosts(postIds: string[]): void {
  mockPostFind.mockReturnValue({
    lean: () => Promise.resolve(postIds.map((_id) => ({ _id }))),
  });
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  OWNER = `650000000000000000${randomUUID().slice(0, 6)}`;
  createdOwners.push(OWNER);
  // Default: every post the ledger carries is published + public.
  mockPostFind.mockImplementation((filter: { _id?: { $in?: string[] } }) => ({
    lean: () => Promise.resolve((filter._id?.$in ?? []).map((_id) => ({ _id }))),
  }));
});

afterEach(async () => {
  while (createdOwners.length > 0) {
    const owner = createdOwners.pop();
    if (owner) await db.delete(mentionSignedRecords).where(eq(mentionSignedRecords.oxyUserId, owner));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('listRecords', () => {
  it('translates posts newest-first into app.bsky.feed.post records', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('first'), createdAt: '2026-06-30T01:00:00.000Z', recordId: 'rid-p1' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'p2', record: postRecord('second'), createdAt: '2026-06-30T02:00:00.000Z', recordId: 'rid-p2' },
    ]);

    const page = await listRecords(OWNER, 'app.bsky.feed.post');

    // Newest-first comes from the ORDER BY, not from insertion order.
    expect(page.records).toHaveLength(2);
    expect(page.records[0].uri).toBe(`at://${buildUserDid(OWNER)}/app.bsky.feed.post/p2`);
    expect(page.records[0].cid).toBe('mtn-rid-p2');
    expect(page.records[0].value).toMatchObject({ $type: 'app.bsky.feed.post', text: 'second' });
    expect(page.records[1].value).toMatchObject({ text: 'first' });
  });

  it('applies LAST-WRITER-WINS per rkey (newest version wins, older dropped)', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('original'), createdAt: '2026-06-30T01:00:00.000Z' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('edited'), createdAt: '2026-06-30T02:00:00.000Z' },
    ]);

    const page = await listRecords(OWNER, 'app.bsky.feed.post');
    expect(page.records).toHaveLength(1);
    expect(page.records[0].value).toMatchObject({ text: 'edited' });
  });

  it('removes a key targeted by a tombstone', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('deleted'), createdAt: '2026-06-30T01:00:00.000Z' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'p2', record: postRecord('alive'), createdAt: '2026-06-30T02:00:00.000Z' },
      {
        nsid: MENTION_TOMBSTONE_COLLECTION,
        rkey: 't1',
        record: { subject: createPostUri(OWNER, 'p1'), createdAt: '2026-06-30T03:00:00.000Z' },
        createdAt: '2026-06-30T03:00:00.000Z',
      },
    ]);

    const page = await listRecords(OWNER, 'app.bsky.feed.post');
    expect(page.records.map((record) => record.rkey)).toEqual(['p2']);
  });

  it('serves likes from their own collection and ignores the post collection', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('a post'), createdAt: '2026-06-30T02:00:00.000Z' },
      {
        nsid: MENTION_LIKE_COLLECTION,
        rkey: 'l1',
        record: { subject: createPostUri('other', 'x'), createdAt: '2026-06-30T01:00:00.000Z' },
        createdAt: '2026-06-30T01:00:00.000Z',
      },
    ]);

    const likes = await listRecords(OWNER, 'app.bsky.feed.like');
    expect(likes.records.map((record) => record.rkey)).toEqual(['l1']);
    expect(likes.records[0].value.$type).toBe('app.bsky.feed.like');
  });

  it('filters draft and non-public post records through the authoritative Post document', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'published-private', record: postRecord('private secret'), createdAt: '2026-06-30T01:00:00.000Z' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'draft-public', record: postRecord('draft secret'), createdAt: '2026-06-30T02:00:00.000Z' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'published-public', record: postRecord('safe'), createdAt: '2026-06-30T03:00:00.000Z' },
    ]);
    publicPosts(['published-public']);

    const page = await listRecords(OWNER, 'app.bsky.feed.post');

    expect(page.records.map((record) => record.rkey)).toEqual(['published-public']);
    expect(mockPostFind).toHaveBeenCalledWith(
      {
        _id: { $in: ['published-public', 'draft-public', 'published-private'] },
        oxyUserId: OWNER,
        status: 'published',
        visibility: 'public',
      },
      { _id: 1 },
    );
  });

  it('never serves a private bookmark, even when the ledger holds one', async () => {
    // The behavioural form of "a non-served collection short-circuits": a real
    // bookmark row exists and still must not reach the bridge.
    await seed([
      {
        nsid: MENTION_BOOKMARK_COLLECTION,
        rkey: 'b1',
        record: { subject: createPostUri(OWNER, 'p1'), createdAt: '2026-06-30T01:00:00.000Z' },
        createdAt: '2026-06-30T01:00:00.000Z',
      },
    ]);

    await expect(listRecords(OWNER, 'app.mention.feed.bookmark')).resolves.toEqual({ records: [] });
    await expect(getRecord(OWNER, 'app.mention.feed.bookmark', 'b1')).resolves.toBeNull();
  });

  it('paginates by rkey cursor and reports the next cursor', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('1'), createdAt: '2026-06-30T01:00:00.000Z' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'p2', record: postRecord('2'), createdAt: '2026-06-30T02:00:00.000Z' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'p3', record: postRecord('3'), createdAt: '2026-06-30T03:00:00.000Z' },
    ]);

    const first = await listRecords(OWNER, 'app.bsky.feed.post', { limit: 2 });
    expect(first.records.map((r) => r.rkey)).toEqual(['p3', 'p2']);
    expect(first.cursor).toBe('p2');

    const second = await listRecords(OWNER, 'app.bsky.feed.post', { limit: 2, cursor: 'p2' });
    expect(second.records.map((r) => r.rkey)).toEqual(['p1']);
    expect(second.cursor).toBeUndefined();
  });

  it('skips a record whose payload fails its lexicon schema (no throw)', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'ok', record: postRecord('valid'), createdAt: '2026-06-30T01:00:00.000Z' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'bad', record: { notText: 1 }, createdAt: '2026-06-30T02:00:00.000Z' },
    ]);

    const page = await listRecords(OWNER, 'app.bsky.feed.post');
    expect(page.records.map((r) => r.rkey)).toEqual(['ok']);
  });

  it("does not serve another user's records", async () => {
    const other = `650000000000000000${randomUUID().slice(0, 6)}`;
    createdOwners.push(other);
    const mine = OWNER;
    OWNER = other;
    await seed([{ nsid: MENTION_POST_COLLECTION, rkey: 'theirs', record: postRecord('not mine'), createdAt: '2026-06-30T05:00:00.000Z' }]);
    OWNER = mine;
    await seed([{ nsid: MENTION_POST_COLLECTION, rkey: 'mine', record: postRecord('mine'), createdAt: '2026-06-30T01:00:00.000Z' }]);

    const page = await listRecords(OWNER, 'app.bsky.feed.post');
    expect(page.records.map((r) => r.rkey)).toEqual(['mine']);
  });
});

describe('getRecord', () => {
  it('resolves a single live record by rkey', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('hi'), createdAt: '2026-06-30T01:00:00.000Z' },
    ]);
    const record = await getRecord(OWNER, 'app.bsky.feed.post', 'p1');
    expect(record?.value).toMatchObject({ text: 'hi' });
  });

  it('reads only the requested key, so a sibling key never leaks into the answer', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('wanted'), createdAt: '2026-06-30T01:00:00.000Z' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'p2', record: postRecord('other'), createdAt: '2026-06-30T02:00:00.000Z' },
    ]);

    const record = await getRecord(OWNER, 'app.bsky.feed.post', 'p1');
    expect(record?.rkey).toBe('p1');
    // The visibility join saw ONLY the requested key — the narrowing is what makes
    // this a targeted read rather than a per-key full scan of the chain.
    expect(mockPostFind).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: ['p1'] } }),
      { _id: 1 },
    );
  });

  it('applies LWW for the requested rkey (newest edit wins)', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('original'), createdAt: '2026-06-30T01:00:00.000Z' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('edited'), createdAt: '2026-06-30T02:00:00.000Z' },
    ]);
    const record = await getRecord(OWNER, 'app.bsky.feed.post', 'p1');
    expect(record?.value).toMatchObject({ text: 'edited' });
  });

  it('returns null when the authoritative Post document is draft or non-public', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('secret'), createdAt: '2026-06-30T01:00:00.000Z' },
    ]);
    publicPosts([]);

    expect(await getRecord(OWNER, 'app.bsky.feed.post', 'p1')).toBeNull();
  });

  it('returns null for a tombstoned record', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('gone'), createdAt: '2026-06-30T01:00:00.000Z' },
      {
        nsid: MENTION_TOMBSTONE_COLLECTION,
        rkey: 't1',
        record: { subject: createPostUri(OWNER, 'p1'), createdAt: '2026-06-30T02:00:00.000Z' },
        createdAt: '2026-06-30T02:00:00.000Z',
      },
    ]);
    expect(await getRecord(OWNER, 'app.bsky.feed.post', 'p1')).toBeNull();
  });

  it('returns null for a missing rkey', async () => {
    expect(await getRecord(OWNER, 'app.bsky.feed.post', 'nope')).toBeNull();
  });
});
