import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * The tuning half of this controller reads and writes `user_settings` through the
 * Postgres repository, so those three cases run against REAL ROWS. The saved-feed
 * half still reads Mongo models and stays mocked above — one controller, two
 * stores, for as long as the port is in progress.
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { userSettings } from '../db/schema/userProfile';
import { loadUserSettings } from '../db/userProfile/userSettingsRepository';
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
/**
 * Namespaced, because vitest runs files in parallel against one database and
 * `user_settings.oxy_user_id` is unique — a bare `'viewer'` is a claim about
 * every other file in the run.
 */
const VIEWER = 'feed-preferences-viewer';
const authed = (body?: unknown) => ({ user: { id: VIEWER }, body }) as never;

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, VIEWER));
  await closePostgres();
});

beforeEach(async () => {
  storedDoc = null;
  customFeedDoc = null;
  // No row at all, which is a DIFFERENT state from a row with nothing tuned —
  // and the one `getTuning`'s empty answer is about.
  await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, VIEWER));
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

describe('GET /feed/tuning', () => {
  it('returns an empty forYou when nothing is stored', async () => {
    const res = makeRes();
    await feedPreferencesController.getTuning(authed(), res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { data: { forYou: unknown } }).data.forYou).toEqual({});
  });

  it('returns the stored forYou tuning', async () => {
    await getDb().insert(userSettings).values({
      oxyUserId: VIEWER,
      tuningMinQualityEnabled: true,
      tuningMinQuality: 0.5,
    });
    const res = makeRes();
    await feedPreferencesController.getTuning(authed(), res as never);
    expect((res.body as { data: { forYou: unknown } }).data.forYou).toEqual({
      minQuality: { enabled: true, minQuality: 0.5 },
    });
  });

  it('401s an anonymous request', async () => {
    const res = makeRes();
    await feedPreferencesController.getTuning({ user: undefined } as never, res as never);
    expect(res.statusCode).toBe(401);
  });
});

describe('PUT /feed/tuning', () => {
  it('validates + persists the forYou tuning (rejecting out-of-range)', async () => {
    const res = makeRes();
    await feedPreferencesController.updateTuning(
      authed({ forYou: { lowEffortGate: { enabled: false }, minQuality: { enabled: true, minQuality: 0.4 } } }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
    // Read BACK from the database, not from the call the controller made: the
    // question is what is stored, and a write built from the right values can
    // still land in the wrong columns.
    expect((await loadUserSettings(VIEWER))?.feedTuning?.forYou).toEqual({
      lowEffortGate: { enabled: false },
      minQuality: { enabled: true, minQuality: 0.4 },
    });
  });

  it('400s an out-of-range threshold and never writes', async () => {
    const res = makeRes();
    await feedPreferencesController.updateTuning(authed({ forYou: { minQuality: { minQuality: 2 } } }), res as never);
    expect(res.statusCode).toBe(400);
    // Nothing written: a rejected body must not half-persist.
    expect(await loadUserSettings(VIEWER)).toBeNull();
  });

  it('400s an unknown tuning module', async () => {
    const res = makeRes();
    await feedPreferencesController.updateTuning(authed({ forYou: { bogus: {} } }), res as never);
    expect(res.statusCode).toBe(400);
    expect(await loadUserSettings(VIEWER)).toBeNull();
  });

  it('401s an anonymous request', async () => {
    const res = makeRes();
    await feedPreferencesController.updateTuning({ user: undefined, body: { forYou: {} } } as never, res as never);
    expect(res.statusCode).toBe(401);
  });
});
