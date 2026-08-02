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
 * The visibility join is REAL too, since batch 7 moved it: the service now
 * reads `posts` from Postgres, so a mocked `Post.find` no longer intercepts
 * anything and every case returned an empty page. Seeding real post rows also
 * removes the last place this suite could assert a QUERY instead of an ANSWER —
 * the two cases that used to check the Mongo filter object now check which
 * records come back, which is the property they were standing in for.
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

import { closePostgres, connectPostgres, type Database } from '../../../../db/postgres';
import { mentionSignedRecords } from '../../../../db/schema/mtn';
import { posts } from '../../../../db/schema/posts';
import { listRecords, getRecord } from '../../../../connectors/atproto/bridge/repoReadService';

let db: Database;
let OWNER = '';
const createdOwners: string[] = [];
const createdPostIds: string[] = [];

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
  // The ordinary case: a post record's authoritative row is published+public.
  // A case that needs otherwise seeds it FIRST and this skips it, so a test can
  // still say "this one is a draft" without fighting the default.
  const already = new Set(createdPostIds);
  const postRows = [
    ...new Set(
      rows.filter((r) => r.nsid === MENTION_POST_COLLECTION && !already.has(r.rkey)).map((r) => r.rkey)
    ),
  ];
  if (postRows.length > 0) await publicPosts(postRows);
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

/**
 * Write the authoritative `posts` rows the visibility join reads back.
 *
 * The ledger carries no visibility of its own, so what keeps a draft or private
 * post off the public bridge is this row — which is why it has to be real. A
 * post id here is the ledger rkey, by construction of the chain.
 */
async function seedPosts(
  specs: { id: string; status?: string; visibility?: string }[]
): Promise<void> {
  if (specs.length === 0) return;
  await db.insert(posts).values(
    specs.map((spec) => ({
      id: spec.id,
      oxyUserId: OWNER,
      status: spec.status ?? 'published',
      visibility: spec.visibility ?? 'public',
    })) as never
  );
  createdPostIds.push(...specs.map((spec) => spec.id));
}

/** Every rkey the ledger carries, published and public — the ordinary case. */
async function publicPosts(postIds: string[]): Promise<void> {
  await seedPosts(postIds.map((id) => ({ id })));
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  OWNER = `650000000000000000${randomUUID().slice(0, 6)}`;
  createdOwners.push(OWNER);
});

afterEach(async () => {
  while (createdPostIds.length > 0) {
    const id = createdPostIds.pop();
    if (id) await db.delete(posts).where(eq(posts.id, id));
  }
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

  it('filters draft and non-public post records through the authoritative post row', async () => {
    // Seeded FIRST so `seed()`'s published+public default does not claim them.
    await seedPosts([
      { id: 'published-private', visibility: 'private' },
      { id: 'draft-public', status: 'draft' },
    ]);
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'published-private', record: postRecord('private secret'), createdAt: '2026-06-30T01:00:00.000Z' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'draft-public', record: postRecord('draft secret'), createdAt: '2026-06-30T02:00:00.000Z' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'published-public', record: postRecord('safe'), createdAt: '2026-06-30T03:00:00.000Z' },
    ]);
    const page = await listRecords(OWNER, 'app.bsky.feed.post');

    // The ANSWER, not the query. The old version asserted the Mongo filter
    // object — which passed whether or not the rows it described existed, and
    // could not have caught a join that returned everything.
    expect(page.records.map((record) => record.rkey)).toEqual(['published-public']);
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
    // The sibling never appears in the answer. The old assertion checked that
    // the visibility join was NARROWED to one key — a statement about how the
    // query was built, which is no longer observable from outside the service.
    // What is observable, and what actually matters to a caller, is that `p2`
    // cannot leak into a read for `p1`.
    expect(record?.value).toMatchObject({ text: 'wanted' });
  });

  it('applies LWW for the requested rkey (newest edit wins)', async () => {
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('original'), createdAt: '2026-06-30T01:00:00.000Z' },
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('edited'), createdAt: '2026-06-30T02:00:00.000Z' },
    ]);
    const record = await getRecord(OWNER, 'app.bsky.feed.post', 'p1');
    expect(record?.value).toMatchObject({ text: 'edited' });
  });

  it('returns null when the authoritative post row is draft or non-public', async () => {
    // Seeded FIRST, as a draft, so `seed()`'s published+public default does not
    // claim this rkey. The ledger row is identical to the served case above —
    // the post row is the only difference, which is the point.
    await seedPosts([{ id: 'p1', status: 'draft' }]);
    await seed([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('secret'), createdAt: '2026-06-30T01:00:00.000Z' },
    ]);

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
