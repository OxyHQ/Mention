import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostVisibility } from '@mention/shared-types';

const mocks = vi.hoisted(() => ({
  redisSet: vi.fn(),
  postExists: vi.fn(),
  postFindOneAndUpdate: vi.fn(),
}));

vi.mock('../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: true,
    isOpen: true,
    connect: vi.fn().mockResolvedValue(undefined),
    // Legacy client surface; ready hot paths execute the operation directly.
    ping: vi.fn().mockResolvedValue('PONG'),
    set: mocks.redisSet,
  }),
}));

vi.mock('../models/Post', () => ({
  Post: {
    exists: mocks.postExists,
    findOneAndUpdate: mocks.postFindOneAndUpdate,
  },
}));

import { isPostEligibleForViewTelemetry, recordDedupedView } from '../services/feedViewCounter';

const POST_ID = '507f1f77bcf86cd799439011';

/** Point `Post.findOneAndUpdate(...).lean()` at the post as it stands AFTER the `$inc`. */
function mockIncrementedTo(viewsCount: number | null): void {
  mocks.postFindOneAndUpdate.mockReturnValue({
    lean: () => Promise.resolve(viewsCount === null ? null : { stats: { viewsCount } }),
  });
}

describe('feedViewCounter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisSet.mockResolvedValue('OK');
    mockIncrementedTo(1);
  });

  it('only treats public published posts as eligible for impression side effects', async () => {
    mocks.postExists.mockResolvedValueOnce({ _id: POST_ID });

    await expect(isPostEligibleForViewTelemetry(POST_ID)).resolves.toBe(true);
    expect(mocks.postExists).toHaveBeenCalledWith({
      _id: POST_ID,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
    });
  });

  it('does not allocate a Redis dedupe key or increment for nonexistent/private/followers-only/draft posts', async () => {
    // The eligibility query (`{ visibility: PUBLIC, status: 'published' }`) does
    // not match private, followers-only, draft, or nonexistent posts, so Mongo
    // resolves `Post.exists` to `null` for every one of those cases — modelling
    // the security guard that keeps forged client telemetry off non-public ids.
    mocks.postExists.mockResolvedValueOnce(null);

    await expect(recordDedupedView(POST_ID, 'attacker_oxy_user')).resolves.toBeNull();

    expect(mocks.postExists).toHaveBeenCalledWith({
      _id: POST_ID,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
    });
    expect(mocks.redisSet).not.toHaveBeenCalled();
    expect(mocks.postFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('treats a followers-only post as ineligible for impression telemetry', async () => {
    // A FOLLOWERS_ONLY post never satisfies the `visibility: PUBLIC` predicate, so
    // `Post.exists` returns null and no view side effects run.
    mocks.postExists.mockResolvedValueOnce(null);

    await expect(isPostEligibleForViewTelemetry(POST_ID)).resolves.toBe(false);
    expect(mocks.postExists).toHaveBeenCalledWith({
      _id: POST_ID,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
    });
  });

  it('keeps the increment guarded by the same public published predicate', async () => {
    mocks.postExists.mockResolvedValueOnce({ _id: POST_ID });
    mockIncrementedTo(43);

    await expect(recordDedupedView(POST_ID, 'viewer_oxy_user')).resolves.toBe(43);

    expect(mocks.redisSet).toHaveBeenCalledWith(`viewseen:${POST_ID}:viewer_oxy_user`, '1', {
      NX: true,
      EX: expect.any(Number),
    });
    expect(mocks.postFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: POST_ID, visibility: PostVisibility.PUBLIC, status: 'published' },
      { $inc: { 'stats.viewsCount': 1 } },
      { new: true, projection: { 'stats.viewsCount': 1 } },
    );
  });

  it('returns the POST-increment total, on the increment own round trip', async () => {
    // `new: true` is the load-bearing option: without it Mongo answers with the
    // document as it was BEFORE the `$inc`, and every client would render a count
    // one view behind the view it just caused — the exact staleness this return
    // value exists to remove, made invisible because the number still moves.
    mocks.postExists.mockResolvedValueOnce({ _id: POST_ID });
    mockIncrementedTo(8);

    await expect(recordDedupedView(POST_ID, 'viewer_oxy_user')).resolves.toBe(8);
    expect(mocks.postFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.postFindOneAndUpdate.mock.calls[0]?.[2]).toMatchObject({ new: true });
  });

  it('reports no count when the dedupe window already claimed this viewer', async () => {
    // `SET NX` returns null when the marker exists: a repeat impression inside the
    // window must neither increment nor report a number, or a client would paint a
    // "+1" the server never performed.
    mocks.postExists.mockResolvedValueOnce({ _id: POST_ID });
    mocks.redisSet.mockResolvedValueOnce(null);

    await expect(recordDedupedView(POST_ID, 'viewer_oxy_user')).resolves.toBeNull();
    expect(mocks.postFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('reports no count when the increment itself fails', async () => {
    mocks.postExists.mockResolvedValueOnce({ _id: POST_ID });
    mocks.postFindOneAndUpdate.mockReturnValueOnce({
      lean: () => Promise.reject(new Error('mongo unavailable')),
    });

    await expect(recordDedupedView(POST_ID, 'viewer_oxy_user')).resolves.toBeNull();
  });
});
