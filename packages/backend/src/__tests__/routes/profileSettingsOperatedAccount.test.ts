import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `PUT /profile/settings/:userId` — the settings of an account the caller
 * OPERATES rather than owns.
 *
 * It exists because a channel account has no login: nobody can ever authenticate
 * AS one, so `PUT /profile/settings` (which resolves its target from the
 * authenticated subject) can never reach a channel's settings. Without this route
 * the `signPosts` toggle is a control that writes nowhere.
 *
 * The route is exercised through the REAL handler with an in-memory store, so
 * these assert behaviour and not the shape of a mock. Mocks mirror
 * `profileSettingsFediverseLanguage.test.ts` — the real `userSettings` module
 * pulls `mediaResolver -> oxyHelpers -> the server entrypoint`, a circular import.
 */

const store = new Map<string, Record<string, unknown>>();
const CALLER = 'user-1';
const CHANNEL = 'channel-account-1';
const OTHER_CHANNEL = 'channel-account-2';
const ORGANIZATION = 'organization-account-1';

function getDoc(oxyUserId: string): Record<string, unknown> {
  let doc = store.get(oxyUserId);
  if (!doc) {
    doc = { oxyUserId };
    store.set(oxyUserId, doc);
  }
  return doc;
}

// The paths here come from the route's own `$set`, but a helper that walks a
// dotted path and assigns is a prototype-pollution primitive whatever feeds it,
// and CodeQL reads it as one. Same guard the sibling settings tests carry.
const FORBIDDEN_DOT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function setDot(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (FORBIDDEN_DOT_KEYS.has(parts[i])) return;
    const next = cur[parts[i]];
    if (typeof next !== 'object' || next === null) cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (FORBIDDEN_DOT_KEYS.has(last)) return;
  cur[last] = value;
}

vi.mock('@oxyhq/core/server', () => ({
  requireOxyAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user?: { id: string }; accessToken?: string }).user = { id: CALLER };
    (req as express.Request & { accessToken?: string }).accessToken = 'test-token';
    next();
  },
  getRequiredOxyUserId: (req: express.Request & { user?: { id: string } }) => req.user?.id ?? '',
}));

/**
 * The settings STORE, faked at the repository seam rather than at the database.
 *
 * `updateUserSettings` takes the same dotted paths the Mongo `$set` took, so the
 * fake stays a path-walking assignment and the assertions still read the shape
 * the route wrote. What it must NOT do is normalize the path: the route writes
 * `channelAccount.signPosts` (the settings path this repository maps to the
 * `channel_account_sign_posts` column) while the WIRE says `channel.signPosts`,
 * and a fake that quietly accepted either would stop telling the two apart.
 */
vi.mock('../../db/userProfile/userSettingsRepository', () => ({
  updateUserSettings: vi.fn(
    async (oxyUserId: string, update: { set?: Record<string, unknown> }) => {
      const doc = getDoc(oxyUserId);
      for (const [path, value] of Object.entries(update.set ?? {})) setDot(doc, path, value);
      return JSON.parse(JSON.stringify(doc));
    },
  ),
  loadUserSettings: vi.fn(async (oxyUserId: string) => store.get(oxyUserId) ?? null),
  ensureUserSettings: vi.fn(async (oxyUserId: string) =>
    JSON.parse(JSON.stringify(getDoc(oxyUserId))),
  ),
  UnknownSettingsPathError: class UnknownSettingsPathError extends Error {},
}));

/**
 * The authorization gate is mocked, not reimplemented: it is unit-tested in
 * `publishAsAccount`'s own suite, and what THIS route has to get right is that it
 * consults that gate at all, honours its status codes, and refuses a target the
 * gate ALLOWS but whose kind makes `channel.signPosts` meaningless — the caller's
 * own account, and (since the gate was widened) an organization the caller may
 * act for.
 */
// `vi.mock` is hoisted above every top-level statement, so the error class and
// the membership map have to be created inside `vi.hoisted` or the factory runs
// before they exist.
const gate = vi.hoisted(() => {
  class PublishAsAccessError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'PublishAsAccessError';
      this.status = status;
    }
  }
  return { PublishAsAccessError, operableKindOf: new Map<string, string>() };
});

vi.mock('../../services/publishAsAccount', () => ({
  PublishAsAccessError: gate.PublishAsAccessError,
  assertCanPublishAsAccount: vi.fn(
    async (params: { publishAsOxyUserId?: string | null; callerId?: string | null }) => {
      const target = params.publishAsOxyUserId?.trim();
      if (!target || target === params.callerId) {
        // The real gate resolves nothing when the target IS the caller, so it
        // answers with no kind. That `null` is what the route reads to refuse.
        return { authorId: params.callerId ?? null, authorKind: null };
      }
      const kind = gate.operableKindOf.get(target);
      if (!kind) {
        throw new gate.PublishAsAccessError(403, 'You are not a member of that account');
      }
      return { authorId: target, authorKind: kind };
    },
  ),
}));

vi.mock('../../utils/userSettings', () => ({
  buildSettingsResponseForViewer: (doc: unknown) => doc,
}));
vi.mock('../../utils/oxyHelpers', () => ({
  ensureProfileMediaPublic: vi.fn().mockResolvedValue(undefined),
  createUserScopedOxyServices: vi.fn(() => ({ listAccountMembers: vi.fn() })),
}));
vi.mock('../../utils/syraPodcast', () => ({ syraClient: {} }));
vi.mock('../../utils/privacyHelpers', () => ({ canViewProfileDesign: vi.fn().mockResolvedValue(true) }));
vi.mock('../../connectors/outboundFederation', () => ({ federateAsResolvedActor: vi.fn() }));
vi.mock('../../models/UserBehavior', () => ({ default: {} }));
vi.mock('../../models/Post', () => ({ default: {} }));
vi.mock('../../models/Bookmark', () => ({ default: {} }));
vi.mock('../../models/Like', () => ({ default: {} }));

import profileSettingsRoutes from '../../routes/profileSettings';

const app = express();
app.use(express.json());
app.use('/profile', profileSettingsRoutes);

describe('PUT /profile/settings/:userId — an operated account', () => {
  beforeEach(() => {
    store.clear();
    gate.operableKindOf.clear();
    gate.operableKindOf.set(CHANNEL, 'channel');
    gate.operableKindOf.set(ORGANIZATION, 'organization');
    vi.clearAllMocks();
  });

  it('persists signPosts for a channel the caller operates', async () => {
    const res = await request(app)
      .put(`/profile/settings/${CHANNEL}`)
      .send({ channel: { signPosts: true } })
      .expect(200);

    expect(res.body.data).toEqual({ channel: { signPosts: true } });
    // Written against the CHANNEL's row, never the caller's — the whole point of
    // the route is that the target is not the authenticated subject.
    expect(store.get(CHANNEL)).toMatchObject({ channelAccount: { signPosts: true } });
    expect(store.has(CALLER)).toBe(false);
  });

  it('turns signPosts back off', async () => {
    await request(app).put(`/profile/settings/${CHANNEL}`).send({ channel: { signPosts: true } }).expect(200);
    const res = await request(app)
      .put(`/profile/settings/${CHANNEL}`)
      .send({ channel: { signPosts: false } })
      .expect(200);

    expect(res.body.data).toEqual({ channel: { signPosts: false } });
    expect(store.get(CHANNEL)).toMatchObject({ channelAccount: { signPosts: false } });
  });

  it('refuses an account the caller does not operate, with the gate\'s status', async () => {
    await request(app)
      .put(`/profile/settings/${OTHER_CHANNEL}`)
      .send({ channel: { signPosts: true } })
      .expect(403);

    expect(store.has(OTHER_CHANNEL)).toBe(false);
  });

  it('refuses the caller\'s own account — `channel.signPosts` means nothing there', async () => {
    await request(app)
      .put(`/profile/settings/${CALLER}`)
      .send({ channel: { signPosts: true } })
      .expect(400);

    expect(store.has(CALLER)).toBe(false);
  });

  /**
   * The hole the widened gate would otherwise open. `assertCanPublishAsAccount`
   * now ALLOWS an organization the caller may act for, so "the gate said yes" is
   * no longer the same statement as "this is a channel" — and `channel.signPosts`
   * is read by `PostHydrationService` for a `kind: 'channel'` author only, so
   * writing it anywhere else stores a control nothing will ever read.
   */
  it('refuses an ORGANIZATION the caller may act for — the gate allows it, the field means nothing there', async () => {
    await request(app)
      .put(`/profile/settings/${ORGANIZATION}`)
      .send({ channel: { signPosts: true } })
      .expect(400);

    expect(store.has(ORGANIZATION)).toBe(false);
  });

  /**
   * The fixtures that matter. `signPosts` decides whether the human who wrote a
   * post is DISCLOSED, so the check is `typeof === 'boolean'` and not a truthiness
   * test — and only a truthy NON-boolean tells those two apart. `true`/`false`/
   * absent all pass either version, so a suite made of those alone would stay
   * green against `Boolean(signPosts)`, which reads `"false"` as consent to
   * disclose.
   */
  it.each([
    ['the string "false"', 'false'],
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['an object', {}],
    ['null', null],
  ])('refuses %s rather than coercing it', async (_label, value) => {
    await request(app)
      .put(`/profile/settings/${CHANNEL}`)
      .send({ channel: { signPosts: value } })
      .expect(400);

    expect(store.has(CHANNEL)).toBe(false);
  });

  it('refuses a body with no channel block at all', async () => {
    await request(app).put(`/profile/settings/${CHANNEL}`).send({}).expect(400);
    expect(store.has(CHANNEL)).toBe(false);
  });
});
