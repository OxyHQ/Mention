import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
  requireOxyAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string }; accessToken?: string }).user = {
      id: TEST_USER,
    };
    (req as express.Request & { accessToken?: string }).accessToken = 'test-token';
    next();
  },
  getRequiredOxyUserId: (req: express.Request & { user?: { id: string } }) => req.user?.id ?? '',
}));

/**
 * The REPOSITORY is the seam, not the model.
 *
 * This suite's subject is the route's whitelist and its dot-path construction —
 * which keys it accepts, which it refuses, and whether it `$set`s or `$unset`s.
 * The dotted-path TRANSLATION and its persistence are the repository's own
 * subject and are covered against real rows in
 * `__tests__/db/userSettingsRepository.test.ts`, so stubbing it here keeps this
 * file about the route while the storage guarantee stays on real rows
 * elsewhere.
 */
vi.mock('../../db/userProfile/userSettingsRepository', () => ({
  ensureUserSettings: (oxyUserId: string) =>
    Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId)))),
  loadUserSettings: (oxyUserId: string) =>
    Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId)))),
  updateUserSettings: (
    oxyUserId: string,
    update: { set?: Record<string, unknown>; unset?: Record<string, unknown> },
  ) => {
    const doc = getDoc(oxyUserId);
    for (const [path, value] of Object.entries(update.set ?? {})) setDot(doc, path, value);
    for (const path of Object.keys(update.unset ?? {})) unsetDot(doc, path);
    return Promise.resolve(JSON.parse(JSON.stringify(doc)));
  },
  UnknownSettingsPathError: class UnknownSettingsPathError extends Error {},
}));

vi.mock('../../utils/userSettings', () => ({
  ensureUserSettings: (oxyUserId: string) =>
    Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId)))),
  buildSettingsResponseForViewer: (doc: unknown, targetUserId: string, viewerUserId: string) =>
    targetUserId === viewerUserId ? doc : {},
}));

vi.mock('../../utils/oxyHelpers', () => ({
  ensureProfileMediaPublic: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/syraPodcast', () => ({
  syraClient: {},
}));

import profileSettingsRoutes from '../../routes/profileSettings';

const app = express();
app.use(express.json());
app.use('/profile', profileSettingsRoutes);

async function getSettings() {
  const res = await request(app).get('/profile/settings/me').expect(200);
  return res.body.data as Record<string, unknown>;
}

describe('PUT /profile/settings Following order', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it.each(['chronological', 'relevance'])(
    'persists %s through the settings read contract',
    async (sort) => {
      await request(app)
        .put('/profile/settings')
        .send({ feedSettings: { following: { sort } } })
        .expect(200);
      expect((await getSettings()).feedSettings).toMatchObject({ following: { sort } });
    },
  );

  it.each(['popular', '', null, 1, {}])(
    'rejects an invalid order without altering the stored value: %s',
    async (sort) => {
      await request(app)
        .put('/profile/settings')
        .send({ feedSettings: { following: { sort: 'relevance' } } })
        .expect(200);
      await request(app)
        .put('/profile/settings')
        .send({ feedSettings: { following: { sort } } })
        .expect(400);
      expect((await getSettings()).feedSettings).toMatchObject({
        following: { sort: 'relevance' },
      });
    },
  );

  it('retains the order when an older client writes only ranking settings', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ feedSettings: { following: { sort: 'relevance' } } })
      .expect(200);
    await request(app)
      .put('/profile/settings')
      .send({ feedSettings: { quality: { boostHighQuality: false } } })
      .expect(200);
    expect((await getSettings()).feedSettings).toMatchObject({
      following: { sort: 'relevance' },
      quality: { boostHighQuality: false },
    });
  });
});
