import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  find: vi.fn(),
  findOne: vi.fn(),
  headFindOne: vi.fn(),
  headUpdate: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock('mongoose', () => ({
  default: {
    startSession: (...args: unknown[]) => mocks.startSession(...args),
  },
}));

vi.mock('../../../models/MentionSignedRecord', () => ({
  MTN_CHAIN_STATUS: {
    CANONICAL: 'canonical',
    CONFLICT: 'conflict',
  },
  MTN_CANONICAL_RECORD_FILTER: {
    chainStatus: { $ne: 'conflict' },
  },
  default: {
    create: (...args: unknown[]) => mocks.create(...args),
    find: (...args: unknown[]) => mocks.find(...args),
    findOne: (...args: unknown[]) => mocks.findOne(...args),
  },
}));

vi.mock('../../../models/MentionRepoHead', () => ({
  default: {
    findOne: (...args: unknown[]) => mocks.headFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mocks.headUpdate(...args),
  },
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { MentionRecordStoreImpl } from '../../../services/mtn/MentionRecordStore';
import { buildUserDid } from '../../../services/mtn/mentionDid';
import {
  MTN_CANONICAL_RECORD_FILTER,
  MTN_CHAIN_STATUS,
} from '../../../models/MentionSignedRecord';

describe('MentionRecordStore event idempotency metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startSession.mockResolvedValue({
      withTransaction: vi.fn(async (operation: () => Promise<void>) => operation()),
      endSession: vi.fn(async () => undefined),
    });
    mocks.create.mockResolvedValue([]);
    mocks.headUpdate.mockResolvedValue({});
  });

  it('persists the producer event atomically with the v2 record and resolves it', async () => {
    const store = new MentionRecordStoreImpl();
    const subject = buildUserDid('actor-1');
    const envelope = {
      version: 2,
      type: 'app_record',
      subject,
      issuer: 'did:web:mention.earth',
      record: { subject: 'mtn://owner/post-1' },
      issuedAt: Date.now(),
      seq: 0,
      prev: null,
      collection: 'app.mention.feed.like',
      rkey: 'relation-1',
      publicKey: '04abc',
      alg: 'ES256K-DER-SHA256',
      signature: 'signature',
    } satisfies SignedRecordEnvelope;
    const idempotencyKey = 'engagement:post.like:relation-1:v1';

    const outcome = await store
      .withIdempotencyKey(idempotencyKey)
      .append(subject, envelope, 'record-1');

    expect(outcome).toEqual({ ok: true, recordId: 'record-1', seq: 0 });
    expect(mocks.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          oxyUserId: 'actor-1',
          recordId: 'record-1',
          idempotencyKey,
          chainStatus: MTN_CHAIN_STATUS.CANONICAL,
        }),
      ],
      expect.objectContaining({ session: expect.any(Object) }),
    );
    expect(mocks.headUpdate).toHaveBeenCalledOnce();

    const lookupQuery = {
      read: vi.fn(),
      select: vi.fn(),
      lean: vi.fn(async () => ({
        recordId: 'record-1',
        seq: 0,
        envelope,
      })),
    };
    lookupQuery.read.mockReturnValue(lookupQuery);
    lookupQuery.select.mockReturnValue(lookupQuery);
    mocks.findOne.mockReturnValue(lookupQuery);

    await expect(
      store.findByIdempotencyKey(subject, idempotencyKey),
    ).resolves.toEqual({
      recordId: 'record-1',
      seq: 0,
      envelope,
    });
    expect(mocks.findOne).toHaveBeenCalledWith({
      oxyUserId: 'actor-1',
      idempotencyKey,
      verified: true,
    });
    expect(lookupQuery.read).toHaveBeenCalledWith('primary');
  });

  it('resolves an archived conflict event from its immutable envelope seq', async () => {
    const store = new MentionRecordStoreImpl();
    const subject = buildUserDid('actor-1');
    const envelope = {
      version: 2,
      type: 'app_record',
      subject,
      issuer: 'did:web:mention.earth',
      record: { subject: 'mtn://owner/post-1' },
      issuedAt: Date.now(),
      seq: 4,
      prev: 'record-3',
      collection: 'app.mention.feed.like',
      rkey: 'relation-1',
      publicKey: '04abc',
      alg: 'ES256K-DER-SHA256',
      signature: 'signature',
    } satisfies SignedRecordEnvelope;
    const query = {
      read: vi.fn(),
      select: vi.fn(),
      lean: vi.fn(async () => ({
        recordId: 'archived-record',
        envelope,
        chainStatus: MTN_CHAIN_STATUS.CONFLICT,
      })),
    };
    query.read.mockReturnValue(query);
    query.select.mockReturnValue(query);
    mocks.findOne.mockReturnValue(query);

    await expect(
      store.findByIdempotencyKey(subject, 'event-1'),
    ).resolves.toEqual({
      recordId: 'archived-record',
      seq: 4,
      envelope,
    });
    expect(mocks.findOne).toHaveBeenCalledWith({
      oxyUserId: 'actor-1',
      idempotencyKey: 'event-1',
      verified: true,
    });
    expect(query.read).toHaveBeenCalledWith('primary');
  });

  it('treats missing status as canonical but fails closed when the head points at a conflict', async () => {
    const store = new MentionRecordStoreImpl();
    const subject = buildUserDid('actor-1');
    const headQuery = {
      read: vi.fn(),
      lean: vi.fn(async () => ({
        seq: 2,
        headRecordId: 'record-2',
        recordCount: 3,
      })),
    };
    headQuery.read.mockReturnValue(headQuery);
    mocks.headFindOne.mockReturnValue(headQuery);
    const recordQuery = {
      read: vi.fn(),
      select: vi.fn(),
      lean: vi.fn(async () => ({ _id: 'row-2' })),
    };
    recordQuery.read.mockReturnValue(recordQuery);
    recordQuery.select.mockReturnValue(recordQuery);
    mocks.findOne.mockReturnValue(recordQuery);

    await expect(store.getHead(subject)).resolves.toEqual({
      seq: 2,
      headRecordId: 'record-2',
      recordCount: 3,
    });
    expect(mocks.findOne).toHaveBeenCalledWith({
      oxyUserId: 'actor-1',
      recordId: 'record-2',
      seq: 2,
      verified: true,
      ...MTN_CANONICAL_RECORD_FILTER,
    });
    expect(headQuery.read).toHaveBeenCalledWith('primary');
    expect(recordQuery.read).toHaveBeenCalledWith('primary');

    recordQuery.lean.mockResolvedValueOnce(null);
    await expect(store.getHead(subject)).rejects.toThrow(
      'inconsistent canonical head',
    );
  });

  it('excludes conflicts from linear logs while keeping legacy rows readable', async () => {
    const store = new MentionRecordStoreImpl();
    const subject = buildUserDid('actor-1');
    const logQuery = {
      sort: vi.fn(),
      limit: vi.fn(),
      lean: vi.fn(async () => []),
    };
    logQuery.sort.mockReturnValue(logQuery);
    logQuery.limit.mockReturnValue(logQuery);
    mocks.find.mockReturnValue(logQuery);

    await expect(store.getLogSince(subject, 3, 20)).resolves.toEqual([]);
    expect(mocks.find).toHaveBeenCalledWith({
      oxyUserId: 'actor-1',
      seq: { $gt: 3 },
      ...MTN_CANONICAL_RECORD_FILTER,
    });

    const cursorQuery = {
      select: vi.fn(),
      lean: vi.fn(async () => ({ seq: 4 })),
    };
    cursorQuery.select.mockReturnValue(cursorQuery);
    mocks.findOne.mockReturnValue(cursorQuery);
    await expect(store.resolveCursorSeq(subject, 'record-4')).resolves.toBe(4);
    expect(mocks.findOne).toHaveBeenCalledWith({
      oxyUserId: 'actor-1',
      recordId: 'record-4',
      ...MTN_CANONICAL_RECORD_FILTER,
    });
  });

  it('keeps conflict archives eligible for per-key LWW materialization', async () => {
    const store = new MentionRecordStoreImpl();
    const subject = buildUserDid('actor-1');
    const materializeQuery = {
      read: vi.fn(),
      sort: vi.fn(),
      lean: vi.fn(async () => ({ envelope: { issuedAt: 42 } })),
    };
    materializeQuery.read.mockReturnValue(materializeQuery);
    materializeQuery.sort.mockReturnValue(materializeQuery);
    const frontierQuery = {
      read: vi.fn(),
      sort: vi.fn(),
      lean: vi.fn(async () => ({ envelope: { issuedAt: 42 } })),
    };
    frontierQuery.read.mockReturnValue(frontierQuery);
    frontierQuery.sort.mockReturnValue(frontierQuery);
    mocks.findOne
      .mockReturnValueOnce(materializeQuery)
      .mockReturnValueOnce(frontierQuery);

    await expect(
      store.materializeCurrent(
        subject,
        'app.mention.feed.post',
        'post-1',
      ),
    ).resolves.toEqual({ issuedAt: 42 });
    await expect(
      store.latestIssuedAtForKey(subject, {
        version: 2,
        type: 'app_record',
        subject,
        issuer: 'did:web:mention.earth',
        record: { text: 'fork' },
        issuedAt: 43,
        seq: 5,
        prev: 'record-4',
        collection: 'app.mention.feed.post',
        rkey: 'post-1',
        publicKey: '04abc',
        alg: 'ES256K-DER-SHA256',
        signature: 'signature',
      }),
    ).resolves.toBe(42);

    expect(mocks.findOne).toHaveBeenNthCalledWith(1, {
      oxyUserId: 'actor-1',
      nsid: 'app.mention.feed.post',
      rkey: 'post-1',
      verified: true,
    });
    expect(mocks.findOne).toHaveBeenNthCalledWith(2, {
      oxyUserId: { $eq: 'actor-1' },
      nsid: { $eq: 'app.mention.feed.post' },
      rkey: { $eq: 'post-1' },
    });
    expect(materializeQuery.read).toHaveBeenCalledWith('primary');
    expect(frontierQuery.read).toHaveBeenCalledWith('primary');
  });
});
