import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level coverage for `postReadMoreAction` + `collapseLongBio` in the
 * `PUT /profile/settings` handler, against a REAL `user_settings` row.
 *
 * It used to run against an in-memory map standing in for the Mongoose model,
 * with a hand-written `setDot` reimplementing Mongo's `$set` semantics. That
 * asserted the fake agreed with itself: the store applied dotted paths the way
 * the test author believed Mongo did, and the route was never observed writing
 * anything. The port to Postgres made the pretence visible — every case
 * returned 500 because the mocks no longer intercepted the path the handler
 * takes.
 *
 * Now the handler writes through `userSettingsRepository` into the real table
 * and every assertion reads the row back. That matters most for the last case:
 * the whole-subdocument-replace regression can only be observed in what was
 * actually STORED, never in what a mock recorded.
 */

const TEST_USER = 'readmorebio-user-1';

vi.mock('@oxyhq/core/server', () => ({
  requireOxyAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string }; accessToken?: string }).user = { id: TEST_USER };
    (req as express.Request & { accessToken?: string }).accessToken = 'test-token';
    next();
  },
  getRequiredOxyUserId: (req: express.Request & { user?: { id: string } }) => req.user?.id ?? '',
}));

vi.mock('../../utils/oxyHelpers', () => ({
  ensureProfileMediaPublic: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/syraPodcast', () => ({
  syraClient: {},
}));

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

describe('PUT /profile/settings — postReadMoreAction + collapseLongBio', () => {
  beforeAll(async () => {
    await connectPostgres();
  });

  afterAll(async () => {
    await closePostgres();
  });

  // Scoped to THIS suite's user id. An unscoped delete against the shared test
  // database reaches other files' rows — vitest runs one worker per file
  // against one server, and that failure surfaces in the file it hits rather
  // than the file that caused it.
  beforeEach(async () => {
    vi.clearAllMocks();
    await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, TEST_USER));
  });

  afterEach(async () => {
    await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, TEST_USER));
  });

  it('persists a valid postReadMoreAction value', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { postReadMoreAction: 'expandInline' } })
      .expect(200);

    const settings = await getSettings();
    expect((settings.appearance as Record<string, unknown>).postReadMoreAction).toBe('expandInline');
  });

  it('rejects an invalid postReadMoreAction value (field keeps its default)', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { postReadMoreAction: 'bogus' } })
      .expect(200);

    // The guarantee is that the invalid value was NOT persisted. What "not
    // persisted" LOOKS like changed with the store: Mongo left the field
    // absent, and `appearance_post_read_more_action` is NOT NULL DEFAULT
    // 'openPost', so the column holds its default instead. Asserting
    // `toBeUndefined()` here would now be asserting the old store's shape, and
    // asserting only "not bogus" would pass against a column that silently
    // accepted anything else.
    const appearance = (await getSettings()).appearance as Record<string, unknown>;
    expect(appearance.postReadMoreAction).toBe('openPost');
  });

  it('persists collapseLongBio as a boolean', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { collapseLongBio: false } })
      .expect(200);

    const settings = await getSettings();
    expect((settings.appearance as Record<string, unknown>).collapseLongBio).toBe(false);
  });

  it('rejects a non-boolean collapseLongBio value (field keeps its default)', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { collapseLongBio: 'yes' } })
      .expect(200);

    // Same reasoning as the postReadMoreAction case above:
    // `appearance_collapse_long_bio` is NOT NULL DEFAULT true.
    const appearance = (await getSettings()).appearance as Record<string, unknown>;
    expect(appearance.collapseLongBio).toBe(true);
  });

  it('still persists themeMode alongside the two new fields in the same request', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { themeMode: 'dark', postReadMoreAction: 'expandInline', collapseLongBio: false } })
      .expect(200);

    // `toMatchObject`, not `toEqual`: every appearance column is NOT NULL with
    // a default, so the DTO now always carries the full set. An exact match
    // would pin unrelated defaults and fail the day any of them changes, which
    // is not what this case is about — it is about all three surviving ONE
    // request together.
    const settings = await getSettings();
    expect(settings.appearance).toMatchObject({
      themeMode: 'dark',
      postReadMoreAction: 'expandInline',
      collapseLongBio: false,
    });
  });

  it('a later partial-appearance request (e.g. color picker sending only primaryColor) does not reset earlier appearance fields', async () => {
    // Regression test for the whole-subdocument-replace bug: `appearance` is a
    // Mongoose single-nested subdocument, so a request that builds it as one
    // nested object under `update['appearance']` silently backfills any field
    // not present in the request with schema defaults, wiping earlier values.
    // `useAppColorSave.ts` sends exactly this kind of partial payload
    // (`{ appearance: { primaryColor: hex } }`) when the user only taps a color
    // swatch — it must not clobber `postReadMoreAction`/`themeMode` set earlier.
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { postReadMoreAction: 'expandInline', themeMode: 'dark' } })
      .expect(200);

    await request(app)
      .put('/profile/settings')
      .send({ appearance: { primaryColor: '#ff0000' } })
      .expect(200);

    const settings = await getSettings();
    expect(settings.appearance).toMatchObject({
      postReadMoreAction: 'expandInline',
      themeMode: 'dark',
      primaryColor: '#ff0000',
    });
  });
});
