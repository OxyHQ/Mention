/**
 * A profile made private or followers-only hides every post page of the
 * account, so the route asks for the account's pages to be swept from
 * Cloudflare's edge (the job re-reads the account before it sweeps). Making a
 * profile public, or changing any other setting, asks for nothing.
 */

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_USER = 'user-privacy-edge-purge';
const mocks = vi.hoisted(() => ({ scheduleAuthorPostPagePurge: vi.fn() }));
vi.mock('../../services/webshell/postPageEdgePurge', () => ({
  scheduleAuthorPostPagePurge: mocks.scheduleAuthorPostPagePurge,
}));

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

// The repository is the seam: this suite's subject is which VALUES the route
// hands it, not how the dotted paths are persisted (that is
// `__tests__/db/userSettingsRepository.test.ts`, against real rows).
vi.mock('../../db/userProfile/userSettingsRepository', () => ({
  ensureUserSettings: (oxyUserId: string) =>
    Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId)))),
  loadUserSettings: (oxyUserId: string) =>
    Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId)))),
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
  ensureUserSettings: (oxyUserId: string) =>
    Promise.resolve(JSON.parse(JSON.stringify(getDoc(oxyUserId)))),
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

describe('PUT /profile/settings and the edge purge', () => {
  beforeEach(() => {
    store.clear();
    captured.length = 0;
    vi.clearAllMocks();
    mocks.scheduleAuthorPostPagePurge.mockResolvedValue(undefined);
  });

  it.each(['private', 'followers_only'])('sweeps the account when it becomes %s', async (value) => {
    await request(app)
      .put('/profile/settings')
      .send({ privacy: { profileVisibility: value } })
      .expect(200);

    expect(mocks.scheduleAuthorPostPagePurge).toHaveBeenCalledWith(TEST_USER);
  });

  it('sweeps nothing when the profile is made public', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ privacy: { profileVisibility: 'public' } })
      .expect(200);

    expect(mocks.scheduleAuthorPostPagePurge).not.toHaveBeenCalled();
  });

  it('sweeps nothing for an unrelated setting', async () => {
    await request(app)
      .put('/profile/settings')
      .send({ privacy: { hiddenWords: ['spoilers'] } })
      .expect(200);

    expect(mocks.scheduleAuthorPostPagePurge).not.toHaveBeenCalled();
  });
});
