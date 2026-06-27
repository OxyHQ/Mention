import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { countDocuments, findOne } = vi.hoisted(() => ({
  countDocuments: vi.fn(),
  findOne: vi.fn(),
}));

// `privacyHelpers` (loaded via importActual below) imports `oxy` from the
// server entrypoint, which would otherwise pull the whole Express app into the
// module graph and trigger a circular import (server.ts mounts the very route
// under test). Stub it so the route can be imported in isolation — same pattern
// as notificationActor.test.ts.
vi.mock('../../../server', () => ({ oxy: {} }));

vi.mock('../../models/Post', () => ({
  default: { countDocuments },
}));

vi.mock('../../models/UserSettings', () => ({
  default: { findOne },
}));

// Mock privacyHelpers directly (not via importActual) — the real module imports
// `oxy` from the server entrypoint, and importActual loads the genuine dep tree,
// re-triggering the server circular import. The three exports the route uses are
// reproduced faithfully: requiresAccessCheck mirrors the real predicate.
vi.mock('../../utils/privacyHelpers', () => ({
  ProfileVisibility: {
    PUBLIC: 'public',
    PRIVATE: 'private',
    FOLLOWERS_ONLY: 'followers_only',
  },
  requiresAccessCheck: (visibility?: string) =>
    visibility === 'private' || visibility === 'followers_only',
  checkFollowAccess: vi.fn().mockResolvedValue(true),
}));

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
