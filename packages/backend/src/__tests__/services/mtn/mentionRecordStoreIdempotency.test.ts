import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findOne: vi.fn(),
  headUpdate: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock('mongoose', () => ({
  default: {
    startSession: (...args: unknown[]) => mocks.startSession(...args),
  },
}));

vi.mock('../../../models/MentionSignedRecord', () => ({
  default: {
    create: (...args: unknown[]) => mocks.create(...args),
    findOne: (...args: unknown[]) => mocks.findOne(...args),
  },
}));

vi.mock('../../../models/MentionRepoHead', () => ({
  default: {
    findOne: vi.fn(),
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
        }),
      ],
      expect.objectContaining({ session: expect.any(Object) }),
    );
    expect(mocks.headUpdate).toHaveBeenCalledOnce();

    const lookupQuery = {
      select: vi.fn(),
      lean: vi.fn(async () => ({
        recordId: 'record-1',
        seq: 0,
        envelope,
      })),
    };
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
  });
});
