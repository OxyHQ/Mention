import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import {
  MENTION_POST_COLLECTION,
  MENTION_LIKE_COLLECTION,
  MENTION_REPOST_COLLECTION,
  MENTION_TOMBSTONE_COLLECTION,
  createPostUri,
} from '@mention/shared-types';
import { buildUserDid } from '../../../../services/mtn/mentionDid';

/**
 * Phase C4 — repo READ service. Reads the MTN signed-record ledger (a MOCKED
 * `MentionSignedRecord`) and projects the CURRENT materialized state of a
 * collection into atproto records: LWW per rkey, tombstone removal, private
 * bookmarks excluded, pagination by rkey cursor. No DB, no network.
 */

const mockFind = vi.fn();
const mockPostFind = vi.fn();

vi.mock('../../../../models/MentionSignedRecord', () => ({
  default: { find: (...a: unknown[]) => mockFind(...a) },
}));

vi.mock('../../../../models/Post', () => ({
  Post: { find: (...a: unknown[]) => mockPostFind(...a) },
}));

import { listRecords, getRecord } from '../../../../connectors/atproto/bridge/repoReadService';

const OWNER = '650000000000000000000abc';

/** Build a denormalized ledger row as the service reads it (lean shape). */
function row(opts: {
  nsid: string;
  rkey: string;
  record: Record<string, unknown>;
  createdAt: string;
  recordId?: string;
}): {
  nsid: string;
  rkey: string;
  recordId?: string;
  createdAt: Date;
  envelope: SignedRecordEnvelope;
} {
  return {
    nsid: opts.nsid,
    rkey: opts.rkey,
    recordId: opts.recordId ?? `rid-${opts.rkey}`,
    createdAt: new Date(opts.createdAt),
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
  };
}

function postRecord(text: string): Record<string, unknown> {
  return { text, createdAt: '2026-06-30T00:00:00.000Z' };
}

/** Mock `find(...).sort(...).lean()` to resolve `rows` (sorted newest-first by the caller). */
function mockLedger(rows: ReturnType<typeof row>[]): void {
  mockFind.mockReturnValue({
    sort: () => ({ lean: () => Promise.resolve(rows) }),
  });
  mockPublicPosts(rows.filter((r) => r.nsid === MENTION_POST_COLLECTION).map((r) => r.rkey));
}

function mockPublicPosts(postIds: string[]): void {
  mockPostFind.mockReturnValue({
    lean: () => Promise.resolve(postIds.map((_id) => ({ _id }))),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('listRecords', () => {
  it('translates posts newest-first into app.bsky.feed.post records', async () => {
    mockLedger([
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p2', record: postRecord('second'), createdAt: '2026-06-30T02:00:00.000Z' }),
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('first'), createdAt: '2026-06-30T01:00:00.000Z' }),
    ]);
    const page = await listRecords(OWNER, 'app.bsky.feed.post');
    expect(page.records).toHaveLength(2);
    expect(page.records[0].uri).toBe(`at://${buildUserDid(OWNER)}/app.bsky.feed.post/p2`);
    expect(page.records[0].cid).toBe('mtn-rid-p2');
    expect(page.records[0].value).toMatchObject({ $type: 'app.bsky.feed.post', text: 'second' });
    expect(page.records[1].value).toMatchObject({ text: 'first' });
  });

  it('applies LAST-WRITER-WINS per rkey (newest version wins, older dropped)', async () => {
    mockLedger([
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('edited'), createdAt: '2026-06-30T02:00:00.000Z' }),
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('original'), createdAt: '2026-06-30T01:00:00.000Z' }),
    ]);
    const page = await listRecords(OWNER, 'app.bsky.feed.post');
    expect(page.records).toHaveLength(1);
    expect(page.records[0].value).toMatchObject({ text: 'edited' });
  });

  it('removes a key targeted by a tombstone', async () => {
    mockLedger([
      row({
        nsid: MENTION_TOMBSTONE_COLLECTION,
        rkey: 't1',
        record: { subject: createPostUri(OWNER, 'p1'), createdAt: '2026-06-30T03:00:00.000Z' },
        createdAt: '2026-06-30T03:00:00.000Z',
      }),
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p2', record: postRecord('alive'), createdAt: '2026-06-30T02:00:00.000Z' }),
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('deleted'), createdAt: '2026-06-30T01:00:00.000Z' }),
    ]);
    const page = await listRecords(OWNER, 'app.bsky.feed.post');
    expect(page.records).toHaveLength(1);
    expect(page.records[0].rkey).toBe('p2');
  });

  it('serves likes and reposts from their own collections', async () => {
    mockLedger([
      row({
        nsid: MENTION_LIKE_COLLECTION,
        rkey: 'l1',
        record: { subject: createPostUri('other', 'x'), createdAt: '2026-06-30T01:00:00.000Z' },
        createdAt: '2026-06-30T01:00:00.000Z',
      }),
    ]);
    const likes = await listRecords(OWNER, 'app.bsky.feed.like');
    expect(likes.records).toHaveLength(1);
    expect(likes.records[0].value.$type).toBe('app.bsky.feed.like');
  });

  it('filters draft and non-public post records through the authoritative Post document', async () => {
    mockLedger([
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'published-public', record: postRecord('safe'), createdAt: '2026-06-30T03:00:00.000Z' }),
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'draft-public', record: postRecord('draft secret'), createdAt: '2026-06-30T02:00:00.000Z' }),
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'published-private', record: postRecord('private secret'), createdAt: '2026-06-30T01:00:00.000Z' }),
    ]);
    mockPublicPosts(['published-public']);

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

  it('returns an empty page for an unknown / private collection', async () => {
    mockLedger([]);
    const page = await listRecords(OWNER, 'app.mention.feed.bookmark');
    expect(page.records).toEqual([]);
    // A non-served collection short-circuits before any ledger read.
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('paginates by rkey cursor and reports the next cursor', async () => {
    const rows = [
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p3', record: postRecord('3'), createdAt: '2026-06-30T03:00:00.000Z' }),
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p2', record: postRecord('2'), createdAt: '2026-06-30T02:00:00.000Z' }),
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('1'), createdAt: '2026-06-30T01:00:00.000Z' }),
    ];
    mockLedger(rows);
    const first = await listRecords(OWNER, 'app.bsky.feed.post', { limit: 2 });
    expect(first.records.map((r) => r.rkey)).toEqual(['p3', 'p2']);
    expect(first.cursor).toBe('p2');

    mockLedger(rows);
    const second = await listRecords(OWNER, 'app.bsky.feed.post', { limit: 2, cursor: 'p2' });
    expect(second.records.map((r) => r.rkey)).toEqual(['p1']);
    expect(second.cursor).toBeUndefined();
  });

  it('skips a record whose payload fails its lexicon schema (no throw)', async () => {
    mockLedger([
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'bad', record: { notText: 1 }, createdAt: '2026-06-30T02:00:00.000Z' }),
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'ok', record: postRecord('valid'), createdAt: '2026-06-30T01:00:00.000Z' }),
    ]);
    const page = await listRecords(OWNER, 'app.bsky.feed.post');
    expect(page.records.map((r) => r.rkey)).toEqual(['ok']);
  });

  it('reads ONLY the requested collection + tombstones (not every feed collection)', async () => {
    mockLedger([]);
    await listRecords(OWNER, 'app.bsky.feed.like');
    const query = mockFind.mock.calls[0]?.[0] as {
      oxyUserId: string;
      verified: boolean;
      $or: Array<Record<string, unknown>>;
    };
    expect(query.oxyUserId).toBe(OWNER);
    expect(query.verified).toBe(true);
    expect(query.$or).toEqual([
      { nsid: MENTION_LIKE_COLLECTION },
      { nsid: MENTION_TOMBSTONE_COLLECTION },
    ]);
  });
});

describe('getRecord', () => {
  it('resolves a single live record by rkey', async () => {
    mockLedger([
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('hi'), createdAt: '2026-06-30T01:00:00.000Z' }),
    ]);
    const record = await getRecord(OWNER, 'app.bsky.feed.post', 'p1');
    expect(record?.value).toMatchObject({ text: 'hi' });
  });

  it('queries ONLY the requested rkey + tombstones (targeted, not a full scan)', async () => {
    mockLedger([
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('hi'), createdAt: '2026-06-30T01:00:00.000Z' }),
    ]);
    await getRecord(OWNER, 'app.bsky.feed.post', 'p1');
    const query = mockFind.mock.calls[0]?.[0] as {
      oxyUserId: string;
      verified: boolean;
      $or: Array<Record<string, unknown>>;
    };
    expect(query.oxyUserId).toBe(OWNER);
    expect(query.verified).toBe(true);
    // The feed-collection clause is narrowed to the single rkey; tombstones are
    // still read in full (they delete by subject, not by their own rkey).
    expect(query.$or).toEqual([
      { nsid: MENTION_POST_COLLECTION, rkey: 'p1' },
      { nsid: MENTION_TOMBSTONE_COLLECTION },
    ]);
  });

  it('applies LWW for the requested rkey (newest edit wins)', async () => {
    mockLedger([
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('edited'), createdAt: '2026-06-30T02:00:00.000Z' }),
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('original'), createdAt: '2026-06-30T01:00:00.000Z' }),
    ]);
    const record = await getRecord(OWNER, 'app.bsky.feed.post', 'p1');
    expect(record?.value).toMatchObject({ text: 'edited' });
  });

  it('returns null when the authoritative Post document is draft or non-public', async () => {
    mockLedger([
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('secret'), createdAt: '2026-06-30T01:00:00.000Z' }),
    ]);
    mockPublicPosts([]);

    expect(await getRecord(OWNER, 'app.bsky.feed.post', 'p1')).toBeNull();
  });

  it('returns null for an unknown / private collection without a ledger read', async () => {
    expect(await getRecord(OWNER, 'app.mention.feed.bookmark', 'b1')).toBeNull();
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('returns null for a tombstoned record', async () => {
    mockLedger([
      row({
        nsid: MENTION_TOMBSTONE_COLLECTION,
        rkey: 't1',
        record: { subject: createPostUri(OWNER, 'p1'), createdAt: '2026-06-30T02:00:00.000Z' },
        createdAt: '2026-06-30T02:00:00.000Z',
      }),
      row({ nsid: MENTION_POST_COLLECTION, rkey: 'p1', record: postRecord('gone'), createdAt: '2026-06-30T01:00:00.000Z' }),
    ]);
    expect(await getRecord(OWNER, 'app.bsky.feed.post', 'p1')).toBeNull();
  });

  it('returns null for a missing rkey', async () => {
    mockLedger([]);
    expect(await getRecord(OWNER, 'app.bsky.feed.post', 'nope')).toBeNull();
  });
});
