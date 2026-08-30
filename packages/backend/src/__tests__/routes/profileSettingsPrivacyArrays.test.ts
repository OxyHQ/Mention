/**
 * `privacy.hiddenWords` and `privacy.restrictedUsers` — element types, not just
 * the container.
 *
 * Both land in a `text[]` column, and `privacy.hiddenWords` is then read by
 * `services/safety/muteWordMatcher.ts` on EVERY feed page the viewer loads. One
 * non-string element accepted here is therefore not a single bad request: it is
 * a STORED value that keeps being read long after the request that wrote it.
 *
 * `interests.tags`, a dozen lines below the two in the route, always filtered its
 * elements. These two checked `Array.isArray` on the container and handed the
 * contents straight to `$set`. The asymmetry is the bug; the tests below pin
 * both halves of the fix — a legitimate array still round-trips unchanged.
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_USER = 'user-privacy-arrays';
const captured: Array<{ set?: Record<string, unknown>; unset?: Record<string, unknown> }> = [];
const store = new Map<string, Record<string, unknown>>();

function getDoc(oxyUserId: string): Record<string, unknown> {
  let doc = store.get(oxyUserId);
  if (!doc) {
    doc = { oxyUserId };
    store.set(oxyUserId, doc);
  }
  return doc;
}

vi.mock('@oxyhq/core/server', () => ({
  requireOxyAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string }; accessToken?: string }).user = { id: TEST_USER };
    (req as express.Request & { accessToken?: string }).accessToken = 'test-token';
    next();
  },
  getRequiredOxyUserId: (req: express.Request & { user?: { id: string } }) => req.user?.id ?? '',
}));

// The repository is the seam: this suite's subject is which VALUES the route
// hands it, not how the dotted paths are persisted (that is
// `__tests__/db/userSettingsRepository.test.ts`, against real rows).
vi.mock('../../db/userProfile/userSettingsRepository', () => ({
  ensureUserSettings: (oxyUserId: string) => Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId)))),
  loadUserSettings: (oxyUserId: string) => Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId)))),
  updateUserSettings: (
    oxyUserId: string,
    update: { set?: Record<string, unknown>; unset?: Record<string, unknown> },
  ) => {
    captured.push(update);
    return Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId))));
  },
  UnknownSettingsPathError: class UnknownSettingsPathError extends Error {},
}));

vi.mock('../../utils/userSettings', () => ({
  ensureUserSettings: (oxyUserId: string) => Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId)))),
  buildSettingsResponseForViewer: (doc: unknown) => doc,
}));
vi.mock('../../utils/oxyHelpers', () => ({
  ensureProfileMediaPublic: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../utils/syraPodcast', () => ({ syraClient: {} }));

import profileSettingsRoutes from '../../routes/profileSettings';

const app = express();
app.use(express.json());
app.use('/profile', profileSettingsRoutes);

/** The single `$set` payload the route built for this request. */
function lastSet(): Record<string, unknown> {
  const update = captured[captured.length - 1];
  return update?.set ?? {};
}

describe('PUT /profile/settings privacy arrays', () => {
  beforeEach(() => {
    store.clear();
    captured.length = 0;
    vi.clearAllMocks();
  });

  it('still stores a legitimate hiddenWords array unchanged', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ privacy: { hiddenWords: ['spoilers', 'politics'] } })
      .expect(200);

    expect(lastSet()['privacy.hiddenWords']).toEqual(['spoilers', 'politics']);
  });

  it('still stores a legitimate restrictedUsers array unchanged, and still clears with an empty one', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ privacy: { restrictedUsers: ['user-a', 'user-b'] } })
      .expect(200);
    expect(lastSet()['privacy.restrictedUsers']).toEqual(['user-a', 'user-b']);

    await request(app)
      .put('/profile/settings')
      .send({ privacy: { restrictedUsers: [] } })
      .expect(200);
    expect(lastSet()['privacy.restrictedUsers']).toEqual([]);
  });

  it('drops a non-string element instead of writing it into the text[] column', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ privacy: { hiddenWords: ['spoilers', { $ne: null }, 42, null, 'politics'] } })
      .expect(200);

    expect(lastSet()['privacy.hiddenWords']).toEqual(['spoilers', 'politics']);
  });

  it('drops a non-string restrictedUsers element too', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ privacy: { restrictedUsers: [{ id: 'user-a' }, 'user-b'] } })
      .expect(200);

    expect(lastSet()['privacy.restrictedUsers']).toEqual(['user-b']);
  });

  it('still ignores a non-array altogether, writing neither path', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ privacy: { hiddenWords: 'spoilers', restrictedUsers: 'user-a' } })
      .expect(200);

    expect(lastSet()).not.toHaveProperty('privacy.hiddenWords');
    expect(lastSet()).not.toHaveProperty('privacy.restrictedUsers');
  });
});
