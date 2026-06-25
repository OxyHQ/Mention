import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostVisibility } from '@mention/shared-types';

const mocks = vi.hoisted(() => ({
  redisSet: vi.fn(),
  postExists: vi.fn(),
  postUpdateOne: vi.fn(),
}));

vi.mock('../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: true,
    isOpen: true,
    connect: vi.fn().mockResolvedValue(undefined),
    set: mocks.redisSet,
  }),
}));

vi.mock('../models/Post', () => ({
  Post: {
    exists: mocks.postExists,
    updateOne: mocks.postUpdateOne,
  },
}));

import { isPostEligibleForViewTelemetry, recordDedupedView } from '../services/feedViewCounter';

const POST_ID = '507f1f77bcf86cd799439011';

describe('feedViewCounter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisSet.mockResolvedValue('OK');
    mocks.postUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
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

  it('does not allocate a Redis dedupe key or increment for nonexistent/private/draft posts', async () => {
    mocks.postExists.mockResolvedValueOnce(null);

    await expect(recordDedupedView(POST_ID, 'attacker_oxy_user')).resolves.toBe(false);

    expect(mocks.redisSet).not.toHaveBeenCalled();
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
  });

  it('keeps the increment guarded by the same public published predicate', async () => {
    mocks.postExists.mockResolvedValueOnce({ _id: POST_ID });

    await expect(recordDedupedView(POST_ID, 'viewer_oxy_user')).resolves.toBe(true);

    expect(mocks.redisSet).toHaveBeenCalledWith(`viewseen:${POST_ID}:viewer_oxy_user`, '1', {
      NX: true,
      EX: expect.any(Number),
    });
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: POST_ID, visibility: PostVisibility.PUBLIC, status: 'published' },
      { $inc: { 'stats.viewsCount': 1 } },
    );
  });
});
