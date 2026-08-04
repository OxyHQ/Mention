import { afterAll, afterEach, beforeAll, describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * Group F — GET/PUT /feed/preferences. The preference store and the settings
 * repository are mocked (this suite is about the controller's validation, not
 * about storage), but the CUSTOM FEED is a real row.
 *
 * It has to be: the ownership check used to read a mocked `models/CustomFeed`,
 * which nothing writes any more — every write goes through
 * `routes/customFeeds.routes.ts` into `custom_feeds`. A mocked `findById`
 * answers whatever it is handed no matter which store the controller asks, so
 * the check passed while the real one refused every feed created since the
 * cutover as `invalid`.
 */

// The preference store is REAL rows too, and for a sharper reason than the
// custom feed above: the GET handler branches on whether the viewer has EVER
// stored a layout, which is not the same question as whether their layout is
// empty. A stub answering `{ savedFeeds: [] }` or `null` reproduces whichever
// the author had in mind, so the distinction — and the re-pinning bug that
// collapsing it causes — is invisible to it.

let settingsDoc: { feedTuning?: { forYou?: unknown } } | null = null;
const settingsUpdate = vi.fn(
  (_oxyUserId: string, update: { set: Record<string, unknown> }) =>
    Promise.resolve({ feedTuning: { forYou: update.set['feedTuning.forYou'] } }),
);
/**
 * The repository is the seam: this suite is about the controller's VALIDATION
 * of `feedTuning.forYou` (bounds, shape, rejection), not about how the tuning
 * is stored. The storage round trip is covered on real rows in
 * `__tests__/db/userSettingsRepository.test.ts`.
 */
vi.mock('../db/userProfile/userSettingsRepository', () => ({
  loadUserSettings: vi.fn(async () => settingsDoc),
  updateUserSettings: (...a: unknown[]) =>
    settingsUpdate(...(a as [string, { set: Record<string, unknown> }])),
}));

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { customFeeds, userFeedPreferences } from '../db/schema/feeds';
import { loadFeedLayout, replaceFeedLayout } from '../db/feeds/feedPreferenceRepository';
import { feedPreferencesController } from '../mtn/controllers/feedPreferences.controller';

/** Scoped to this file: `custom_feeds` is shared by every parallel suite. */
const FEED_OWNER = 'oxy-fp-someone-else';

/** A real feed owned by someone OTHER than the authenticated viewer. */
async function seedCustomFeed(options: { isPublic: boolean }): Promise<string> {
  const [row] = await getDb()
    .insert(customFeeds)
    .values({ ownerOxyUserId: FEED_OWNER, title: 'fp feed', isPublic: options.isPublic })
    .returning({ id: customFeeds.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await getDb().delete(customFeeds).where(eq(customFeeds.ownerOxyUserId, FEED_OWNER));
  // `user_saved_feeds` cascades from `user_feed_preferences`.
  await getDb().delete(userFeedPreferences).where(eq(userFeedPreferences.oxyUserId, VIEWER));
});

afterAll(async () => {
  await closePostgres();
});

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
}
/** Scoped to this file: `user_feed_preferences` is shared by every parallel suite. */
const VIEWER = 'oxy-fp-viewer';
const authed = (body?: unknown) => ({ user: { id: VIEWER }, body }) as never;

/** The layout as the store actually holds it. */
async function storedLayout() {
  return loadFeedLayout(VIEWER);
}

beforeEach(async () => {
  await getDb().delete(userFeedPreferences).where(eq(userFeedPreferences.oxyUserId, VIEWER));
  settingsDoc = null;
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
    await replaceFeedLayout(VIEWER, [
      { key: 'for_you', descriptor: 'for_you', pinned: false, order: 0 },
    ]);
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
    const { savedFeeds: persisted } = await storedLayout();
    expect(persisted[0]).toEqual({ key: 'for_you', descriptor: 'for_you', pinned: true, order: 0 });
    expect((persisted[0] as unknown as Record<string, unknown>).evil).toBeUndefined();
  });

  it('400s an invalid descriptor', async () => {
    const res = makeRes();
    await feedPreferencesController.update(
      authed({ savedFeeds: [{ key: 'x', descriptor: 'not_a_feed', pinned: false, order: 0 }] }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
    // Nothing was stored — a rejected layout must not half-apply.
    expect(await storedLayout()).toEqual({ savedFeeds: [], hasStored: false });
  });

  it('400s when savedFeeds is not an array', async () => {
    const res = makeRes();
    await feedPreferencesController.update(authed({ savedFeeds: 'nope' }), res as never);
    expect(res.statusCode).toBe(400);
  });

  it('403s a custom feed the viewer does not own and is not public', async () => {
    const feedId = await seedCustomFeed({ isPublic: false });
    const res = makeRes();
    await feedPreferencesController.update(
      authed({ savedFeeds: [{ key: 'c', descriptor: `custom|${feedId}`, pinned: false, order: 0 }] }),
      res as never,
    );
    expect(res.statusCode).toBe(403);
    expect(await storedLayout()).toEqual({ savedFeeds: [], hasStored: false });
  });

  it('accepts a public custom feed owned by someone else', async () => {
    const feedId = await seedCustomFeed({ isPublic: true });
    const res = makeRes();
    await feedPreferencesController.update(
      authed({ savedFeeds: [{ key: 'c', descriptor: `custom|${feedId}`, pinned: false, order: 0 }] }),
      res as never,
    );
    expect(res.statusCode).toBe(200);
  });

  it('400s a custom feed id that names no row', async () => {
    // `invalid` is the answer for a feed that does not exist. The uuid-shaped id
    // matters: the previous `ObjectId.isValid` guard rejected every real feed id
    // here before any lookup, so this case and the two above all passed for the
    // wrong reason.
    const res = makeRes();
    await feedPreferencesController.update(
      authed({ savedFeeds: [{ key: 'c', descriptor: 'custom|fp-no-such-feed', pinned: false, order: 0 }] }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
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
    settingsDoc = { feedTuning: { forYou: { minQuality: { enabled: true, minQuality: 0.5 } } } };
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
    const persisted = settingsUpdate.mock.calls[0][1].set['feedTuning.forYou'];
    expect(persisted).toEqual({
      lowEffortGate: { enabled: false },
      minQuality: { enabled: true, minQuality: 0.4 },
    });
  });

  it('400s an out-of-range threshold and never writes', async () => {
    const res = makeRes();
    await feedPreferencesController.updateTuning(authed({ forYou: { minQuality: { minQuality: 2 } } }), res as never);
    expect(res.statusCode).toBe(400);
    expect(settingsUpdate).not.toHaveBeenCalled();
  });

  it('400s an unknown tuning module', async () => {
    const res = makeRes();
    await feedPreferencesController.updateTuning(authed({ forYou: { bogus: {} } }), res as never);
    expect(res.statusCode).toBe(400);
    expect(settingsUpdate).not.toHaveBeenCalled();
  });

  it('401s an anonymous request', async () => {
    const res = makeRes();
    await feedPreferencesController.updateTuning({ user: undefined, body: { forYou: {} } } as never, res as never);
    expect(res.statusCode).toBe(401);
  });
});
