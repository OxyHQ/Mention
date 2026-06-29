import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level coverage for the `externalEmbeds` whitelist in the
 * `PUT /profile/settings` handler. Exercises the REAL route handler against an
 * in-memory UserSettings store so the test asserts the actual whitelist +
 * dot-notation `$set`/`$unset` behaviour and the round-trip through GET.
 */

// In-memory settings store keyed by oxyUserId. Mirrors Mongo's findOneAndUpdate
// upsert with dot-notation $set/$unset so the handler's exact mutation shape is
// what we assert on.
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

// Keys that could pollute Object.prototype if assigned via dot-notation.
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

// ensureUserSettings / buildSettingsResponseForViewer are reproduced faithfully
// here (the real module pulls mediaResolver -> oxyHelpers -> the server
// entrypoint, a circular import). The owner branch returns the doc as-is, which
// is exactly what lets externalEmbeds flow out of GET /settings/me.
vi.mock('../../utils/userSettings', () => ({
  ensureUserSettings: (oxyUserId: string) => Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId)))),
  buildSettingsResponseForViewer: (
    doc: unknown,
    targetUserId: string,
    viewerUserId: string,
  ) => (targetUserId === viewerUserId ? doc : {}),
}));

// oxyHelpers + syraPodcast pull the server entrypoint / @syra.fm/sdk; neither is
// needed for the externalEmbeds path, so stub the symbols the route imports.
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

import profileSettingsRoutes from '../../routes/profileSettings';

const app = express();
app.use(express.json());
app.use('/profile', profileSettingsRoutes);

async function getSettings() {
  const res = await request(app).get('/profile/settings/me').expect(200);
  return res.body.data as Record<string, unknown>;
}

describe('PUT /profile/settings externalEmbeds whitelist', () => {
  beforeEach(() => {
    store.clear();
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
