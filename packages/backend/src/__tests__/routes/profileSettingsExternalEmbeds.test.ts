import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level coverage for the `externalEmbeds` whitelist in the
 * `PUT /profile/settings` handler. Exercises the REAL route handler against an
 * in-memory UserSettings store so the test asserts the actual whitelist +
 * dot-notation `$set`/`$unset` behaviour and the round-trip through GET.
 */

// In-memory settings store keyed by oxyUserId. Mirrors Mongo's findOneAndUpdate
// upsert with dot-notation $set/$unset so the handler's exact mutation shape is
// what we assert on.
/**
 * The account under test, namespaced: vitest runs files in parallel against one
 * database and `user_settings.oxy_user_id` is unique, so a bare `user-1` would
 * be a claim about every other file in the run.
 */
const TEST_USER = 'profileSettingsExternalEmbeds-user';

// Auth: inject a fixed authenticated user so the route runs without real tokens.
vi.mock('@oxyhq/core/server', () => ({
  requireOxyAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string }; accessToken?: string }).user = { id: TEST_USER };
    (req as express.Request & { accessToken?: string }).accessToken = 'test-token';
    next();
  },
  getRequiredOxyUserId: (req: express.Request & { user?: { id: string } }) => req.user?.id ?? '',
}));

// UserSettings model: only findOneAndUpdate is exercised by the PUT path.
/**
 * `user_settings` is REAL here.
 *
 * The route writes through `updateUserSettings`, which maps a dotted settings
 * path onto flat columns. The double this replaces reproduced that mapping in
 * the test with its own `setDot`/`unsetDot` pair, so it could only ever confirm
 * the test's model of it — and these cases are precisely about which paths
 * survive the mapping. A key the repository silently drops looks identical to a
 * key the route rejected; only a row tells them apart.
 */

// `buildSettingsResponseForViewer` is reproduced faithfully here: the real
// module pulls mediaResolver -> oxyHelpers -> the server entrypoint, a circular
// import. The owner branch returns the doc as-is, which is what lets the fields
// under test flow out of GET /settings/me.
vi.mock('../../utils/userSettings', () => ({
  buildSettingsResponseForViewer: (
    doc: unknown,
    targetUserId: string,
    viewerUserId: string,
  ) => (targetUserId === viewerUserId ? doc : {}),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  ensureProfileMediaPublic: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/syraPodcast', () => ({
  syraClient: {},
}));

// Models only used by unrelated routes in this file (export / behavior reset).
vi.mock('../../models/UserBehavior', () => ({ default: {} }));
vi.mock('../../models/Post', () => ({ default: {} }));
vi.mock('../../models/Bookmark', () => ({ default: {} }));
vi.mock('../../models/Like', () => ({ default: {} }));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { userSettings } from '../../db/schema/userProfile';
import profileSettingsRoutes from '../../routes/profileSettings';

const app = express();
app.use(express.json());
app.use('/profile', profileSettingsRoutes);

async function getSettings() {
  const res = await request(app).get('/profile/settings/me').expect(200);
  return res.body.data as Record<string, unknown>;
}

describe('PUT /profile/settings externalEmbeds whitelist', () => {
  beforeAll(async () => {
    await connectPostgres();
  });

  afterAll(async () => {
    await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, TEST_USER));
    await closePostgres();
  });

  beforeEach(async () => {
    await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, TEST_USER));
    vi.clearAllMocks();
  });

  it('persists a valid show preference and round-trips it via GET', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ externalEmbeds: { youtube: 'show' } })
      .expect(200);

    const settings = await getSettings();
    expect(settings.externalEmbeds).toEqual({ youtube: 'show' });
  });

  it('persists hide and supports multiple providers', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ externalEmbeds: { spotify: 'hide', giphy: 'show' } })
      .expect(200);

    const settings = await getSettings();
    expect(settings.externalEmbeds).toEqual({ spotify: 'hide', giphy: 'show' });
  });

  it('ignores an unknown provider key', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ externalEmbeds: { foo: 'show', youtube: 'show' } })
      .expect(200);

    const settings = await getSettings();
    expect(settings.externalEmbeds).toEqual({ youtube: 'show' });
    expect((settings.externalEmbeds as Record<string, unknown>).foo).toBeUndefined();
  });

  it('ignores a value that is neither show nor hide', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ externalEmbeds: { youtube: 'bogus' } })
      .expect(200);

    const settings = await getSettings();
    // No valid op was produced, so the field was never created.
    expect((settings.externalEmbeds as Record<string, unknown> | undefined)?.youtube).toBeUndefined();
  });

  it('unsets a previously-set field when passed null', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ externalEmbeds: { youtube: 'show', vimeo: 'hide' } })
      .expect(200);

    await request(app)
      .put('/profile/settings')
      .send({ externalEmbeds: { youtube: null } })
      .expect(200);

    const settings = await getSettings();
    expect(settings.externalEmbeds).toEqual({ vimeo: 'hide' });
  });
});
