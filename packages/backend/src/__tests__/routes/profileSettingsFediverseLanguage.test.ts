import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const store = new Map<string, Record<string, unknown>>();
const TEST_USER = 'user-1';

function getDoc(oxyUserId: string): Record<string, unknown> {
  let doc = store.get(oxyUserId);
  if (!doc) {
    doc = { oxyUserId };
    store.set(oxyUserId, doc);
  }
  return doc;
}

const FORBIDDEN_DOT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setDot(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (FORBIDDEN_DOT_KEYS.has(parts[i])) return;
    const next = cur[parts[i]];
    if (typeof next !== 'object' || next === null) {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (FORBIDDEN_DOT_KEYS.has(last)) return;
  cur[last] = value;
}

function unsetDot(obj: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (FORBIDDEN_DOT_KEYS.has(parts[i])) return;
    const next = cur[parts[i]];
    if (typeof next !== 'object' || next === null) return;
    cur = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (FORBIDDEN_DOT_KEYS.has(last)) return;
  delete cur[last];
}

vi.mock('@oxyhq/core/server', () => ({
  requireOxyAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string }; accessToken?: string }).user = { id: TEST_USER };
    (req as express.Request & { accessToken?: string }).accessToken = 'test-token';
    next();
  },
  getRequiredOxyUserId: (req: express.Request & { user?: { id: string } }) => req.user?.id ?? '',
}));

vi.mock('../../models/UserSettings', () => ({
  default: {
    findOneAndUpdate: vi.fn((filter: { oxyUserId: string }, operation: Record<string, Record<string, unknown>>) => {
      const doc = getDoc(filter.oxyUserId);
      if (operation.$set) {
        for (const [path, value] of Object.entries(operation.$set)) setDot(doc, path, value);
      }
      if (operation.$unset) {
        for (const path of Object.keys(operation.$unset)) unsetDot(doc, path);
      }
      return { lean: () => Promise.resolve(JSON.parse(JSON.stringify(doc))) };
    }),
  },
}));

vi.mock('../../utils/userSettings', () => ({
  ensureUserSettings: (oxyUserId: string) => Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId)))),
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

import profileSettingsRoutes from '../../routes/profileSettings';

const app = express();
app.use(express.json());
app.use('/profile', profileSettingsRoutes);

async function getSettings() {
  const res = await request(app).get('/profile/settings/me').expect(200);
  return res.body.data as Record<string, unknown>;
}

describe('PUT /profile/settings fediversePreferredLanguage', () => {
  beforeEach(() => {
    store.clear();
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
