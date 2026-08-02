import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level coverage for the `fediversePreferredLanguage` field in the
 * `PUT /profile/settings` handler. Exercises the REAL route handler against an
 * in-memory UserSettings store so the test asserts the actual canonicalization,
 * 400-on-invalid, and clear-via-unset behaviour, plus the round-trip through
 * GET /settings/me.
 *
 * Mocks mirror `profileSettingsExternalEmbeds.test.ts` (the real userSettings
 * module pulls mediaResolver -> oxyHelpers -> the server entrypoint, a circular
 * import, so it is reproduced faithfully here).
 */

/**
 * The account under test, namespaced: vitest runs files in parallel against one
 * database and `user_settings.oxy_user_id` is unique, so a bare `user-1` would
 * be a claim about every other file in the run.
 */
const TEST_USER = 'profile-settings-fediverse-language-user';

// Auth: inject a fixed authenticated user so the route runs without real tokens.
vi.mock('@oxyhq/core/server', () => ({
  requireOxyAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string }; accessToken?: string }).user = { id: TEST_USER };
    (req as express.Request & { accessToken?: string }).accessToken = 'test-token';
    next();
  },
  getRequiredOxyUserId: (req: express.Request & { user?: { id: string } }) => req.user?.id ?? '',
}));

/**
 * `user_settings` is REAL here.
 *
 * The route writes through `updateUserSettings`, which maps a dotted settings
 * path onto flat columns. The double this replaces reproduced that mapping in
 * the test with its own `setDot`/`unsetDot` pair, so it could only ever confirm
 * the test's model of it — and these cases are precisely about which values
 * survive it. A value the repository silently drops looks identical to one the
 * route rejected; only a row tells them apart.
 */

// `buildSettingsResponseForViewer` is reproduced faithfully here: the real
// module pulls mediaResolver -> oxyHelpers -> the server entrypoint, a circular
// import. The owner branch returns the doc as-is, which is what lets the field
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

describe('PUT /profile/settings fediversePreferredLanguage', () => {
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

  it('stores a plain base tag and round-trips it via GET', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ fediversePreferredLanguage: 'en' })
      .expect(200);

    const settings = await getSettings();
    expect(settings.fediversePreferredLanguage).toBe('en');
  });

  it('preserves a canonical region tag (es-ES)', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ fediversePreferredLanguage: 'es-ES' })
      .expect(200);

    const settings = await getSettings();
    expect(settings.fediversePreferredLanguage).toBe('es-ES');
  });

  it('canonicalizes an underscore/lowercase tag (pt_BR -> pt-BR)', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ fediversePreferredLanguage: 'pt_BR' })
      .expect(200);

    const settings = await getSettings();
    expect(settings.fediversePreferredLanguage).toBe('pt-BR');
  });

  it('rejects an invalid tag with 400 and stores nothing', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ fediversePreferredLanguage: 'not a language!!' })
      .expect(400);

    const settings = await getSettings();
    expect(settings.fediversePreferredLanguage).toBeUndefined();
  });

  it('rejects a non-string value with 400', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ fediversePreferredLanguage: 123 })
      .expect(400);

    const settings = await getSettings();
    expect(settings.fediversePreferredLanguage).toBeUndefined();
  });

  it('unsets a previously-set preference when passed null', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ fediversePreferredLanguage: 'fr' })
      .expect(200);

    await request(app)
      .put('/profile/settings')
      .send({ fediversePreferredLanguage: null })
      .expect(200);

    const settings = await getSettings();
    expect(settings.fediversePreferredLanguage).toBeUndefined();
  });

  it('unsets a previously-set preference when passed an empty string', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ fediversePreferredLanguage: 'de' })
      .expect(200);

    await request(app)
      .put('/profile/settings')
      .send({ fediversePreferredLanguage: '   ' })
      .expect(200);

    const settings = await getSettings();
    expect(settings.fediversePreferredLanguage).toBeUndefined();
  });

  it('leaves the field untouched when the key is absent from the payload', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ fediversePreferredLanguage: 'it' })
      .expect(200);

    // A subsequent unrelated update must not clear the stored preference.
    await request(app)
      .put('/profile/settings')
      .send({ externalEmbeds: { youtube: 'show' } })
      .expect(200);

    const settings = await getSettings();
    expect(settings.fediversePreferredLanguage).toBe('it');
  });
});
