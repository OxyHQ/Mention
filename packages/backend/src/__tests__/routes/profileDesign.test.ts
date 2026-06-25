import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { countDocuments, findOne } = vi.hoisted(() => ({
  countDocuments: vi.fn(),
  findOne: vi.fn(),
}));

vi.mock('../../models/Post', () => ({
  default: { countDocuments },
}));

vi.mock('../../models/UserSettings', () => ({
  default: { findOne },
}));

vi.mock('../../utils/privacyHelpers', async () => {
  const actual = await vi.importActual<typeof import('../../utils/privacyHelpers')>('../../utils/privacyHelpers');
  return {
    ...actual,
    checkFollowAccess: vi.fn().mockResolvedValue(true),
  };
});

import profileDesignRoutes from '../../routes/profileDesign';

const app = express();
app.use('/profile/design', profileDesignRoutes);

describe('profile design public counts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    countDocuments.mockResolvedValue(0);
  });

  it('counts only published public posts, boosts, and replies', async () => {
    await request(app).get('/profile/design/user-1').expect(200);

    expect(countDocuments).toHaveBeenCalledTimes(3);
    expect(countDocuments).toHaveBeenNthCalledWith(1, {
      oxyUserId: 'user-1',
      visibility: 'public',
      status: 'published',
      parentPostId: null,
    });
    expect(countDocuments).toHaveBeenNthCalledWith(2, {
      oxyUserId: 'user-1',
      visibility: 'public',
      status: 'published',
      type: 'boost',
    });
    expect(countDocuments).toHaveBeenNthCalledWith(3, {
      oxyUserId: 'user-1',
      visibility: 'public',
      status: 'published',
      parentPostId: { $ne: null },
    });
  });
});
