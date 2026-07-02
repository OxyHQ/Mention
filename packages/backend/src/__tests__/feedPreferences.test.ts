import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Group F — GET/PUT /feed/preferences. Models are mocked; the controller's
 * default-seed merge, whitelist, descriptor validation, custom-feed ownership
 * check, upsert, and auth guard are asserted directly.
 */

let storedDoc: { savedFeeds: unknown[] } | null = null;
const findOneAndUpdate = vi.fn((_q: unknown, update: { $set: { savedFeeds: unknown[] } }) => ({
  lean: async () => ({ savedFeeds: update.$set.savedFeeds }),
}));
vi.mock('../models/UserFeedPreference', () => ({
  default: {
    findOne: vi.fn(() => ({ lean: async () => storedDoc })),
    findOneAndUpdate: (...a: unknown[]) => findOneAndUpdate(...(a as [unknown, { $set: { savedFeeds: unknown[] } }])),
  },
}));

let customFeedDoc: { ownerOxyUserId: string; isPublic: boolean } | null = null;
vi.mock('../models/CustomFeed', () => ({
  default: { findById: vi.fn(() => ({ lean: async () => customFeedDoc })) },
}));

import { feedPreferencesController } from '../mtn/controllers/feedPreferences.controller';

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
}
const authed = (body?: unknown) => ({ user: { id: 'viewer' }, body }) as never;

beforeEach(() => {
  storedDoc = null;
  customFeedDoc = null;
  vi.clearAllMocks();
});

describe('GET /feed/preferences', () => {
  it('seeds the preset defaults (For You + Following pinned) when nothing stored', async () => {
    const res = makeRes();
    await feedPreferencesController.get(authed(), res as never);
    const saved = (res.body as { data: { savedFeeds: Array<{ descriptor: string; pinned: boolean }> } }).data.savedFeeds;
    const forYou = saved.find((f) => f.descriptor === 'for_you');
    const following = saved.find((f) => f.descriptor === 'following');
    const trending = saved.find((f) => f.descriptor === 'trending');
    expect(forYou?.pinned).toBe(true);
    expect(following?.pinned).toBe(true);
    expect(trending?.pinned).toBe(false);
  });

  it('appends not-yet-stored presets as unpinned on top of stored feeds', async () => {
    storedDoc = { savedFeeds: [{ key: 'for_you', descriptor: 'for_you', pinned: false, order: 0 }] };
    const res = makeRes();
    await feedPreferencesController.get(authed(), res as never);
    const saved = (res.body as { data: { savedFeeds: Array<{ descriptor: string; pinned: boolean }> } }).data.savedFeeds;
    expect(saved.find((f) => f.descriptor === 'for_you')?.pinned).toBe(false); // stored value preserved
    expect(saved.find((f) => f.descriptor === 'following')?.pinned).toBe(false); // appended unpinned
  });

  it('401s an anonymous request', async () => {
    const res = makeRes();
    await feedPreferencesController.get({ user: undefined } as never, res as never);
    expect(res.statusCode).toBe(401);
  });
});

describe('PUT /feed/preferences', () => {
  it('persists a whitelisted savedFeeds array', async () => {
    const res = makeRes();
    await feedPreferencesController.update(
      authed({ savedFeeds: [{ key: 'for_you', descriptor: 'for_you', pinned: true, order: 0, evil: 'drop-me' }] }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const persisted = findOneAndUpdate.mock.calls[0][1].$set.savedFeeds as Array<Record<string, unknown>>;
    expect(persisted[0]).toEqual({ key: 'for_you', descriptor: 'for_you', pinned: true, order: 0 });
    expect(persisted[0].evil).toBeUndefined();
  });

  it('400s an invalid descriptor', async () => {
    const res = makeRes();
    await feedPreferencesController.update(
      authed({ savedFeeds: [{ key: 'x', descriptor: 'not_a_feed', pinned: false, order: 0 }] }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('400s when savedFeeds is not an array', async () => {
    const res = makeRes();
    await feedPreferencesController.update(authed({ savedFeeds: 'nope' }), res as never);
    expect(res.statusCode).toBe(400);
  });

  it('403s a custom feed the viewer does not own and is not public', async () => {
    customFeedDoc = { ownerOxyUserId: 'someone-else', isPublic: false };
    const res = makeRes();
    await feedPreferencesController.update(
      authed({ savedFeeds: [{ key: 'c', descriptor: 'custom|507f1f77bcf86cd799439011', pinned: false, order: 0 }] }),
      res as never,
    );
    expect(res.statusCode).toBe(403);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('accepts a public custom feed owned by someone else', async () => {
    customFeedDoc = { ownerOxyUserId: 'someone-else', isPublic: true };
    const res = makeRes();
    await feedPreferencesController.update(
      authed({ savedFeeds: [{ key: 'c', descriptor: 'custom|507f1f77bcf86cd799439011', pinned: false, order: 0 }] }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
  });

  it('401s an anonymous request', async () => {
    const res = makeRes();
    await feedPreferencesController.update({ user: undefined, body: { savedFeeds: [] } } as never, res as never);
    expect(res.statusCode).toBe(401);
  });
});
