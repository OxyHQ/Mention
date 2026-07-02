import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level coverage for `postReadMoreAction` + `collapseLongBio` in the
 * `PUT /profile/settings` handler. Same harness shape as
 * `profileSettingsExternalEmbeds.test.ts` — exercises the real route handler
 * against an in-memory UserSettings store.
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

describe('PUT /profile/settings — postReadMoreAction + collapseLongBio', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('persists a valid postReadMoreAction value', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { postReadMoreAction: 'expandInline' } })
      .expect(200);

    const settings = await getSettings();
    expect((settings.appearance as Record<string, unknown>).postReadMoreAction).toBe('expandInline');
  });

  it('rejects an invalid postReadMoreAction value (field left unset)', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { postReadMoreAction: 'bogus' } })
      .expect(200);

    const settings = await getSettings();
    expect((settings.appearance as Record<string, unknown> | undefined)?.postReadMoreAction).toBeUndefined();
  });

  it('persists collapseLongBio as a boolean', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { collapseLongBio: false } })
      .expect(200);

    const settings = await getSettings();
    expect((settings.appearance as Record<string, unknown>).collapseLongBio).toBe(false);
  });

  it('rejects a non-boolean collapseLongBio value (field left unset)', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { collapseLongBio: 'yes' } })
      .expect(200);

    const settings = await getSettings();
    expect((settings.appearance as Record<string, unknown> | undefined)?.collapseLongBio).toBeUndefined();
  });

  it('still persists themeMode alongside the two new fields in the same request', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ appearance: { themeMode: 'dark', postReadMoreAction: 'expandInline', collapseLongBio: false } })
      .expect(200);

    const settings = await getSettings();
    expect(settings.appearance).toEqual({
      themeMode: 'dark',
      postReadMoreAction: 'expandInline',
      collapseLongBio: false,
    });
  });
});
