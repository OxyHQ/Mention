import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signRequest, type HttpSignatureSigner } from '@oxyhq/federation';

/**
 * Contract tests for the fediverseSharing gate on every user-scoped AP /
 * discovery surface: webfinger, actor, outbox, followers, following, user
 * inbox POST, and post dereference. When sharing is OFF each surface must
 * return the SAME body as an unknown user (`{ error: 'User not found' }`) —
 * see `docs/superpowers/specs/2026-07-02-fediverse-sharing-consent-design.md`.
 *
 * The routers now come from the shared `@oxyhq/federation` engine (webfinger +
 * actor + inbox + follow-graph) plus Mention's content router (outbox / featured /
 * post dereference), bound in `engine.routes.ts` / `ap.routes.ts`. The gate logic +
 * the Mention consent reads (`isFediverseSharingEnabledFromUser` /
 * `getFediverseSharingStateByUsername`) are unchanged; these tests verify the
 * wiring produces the same 404-when-off behaviour end to end.
 *
 * 5 of the 6 GET surfaces (actor, outbox, followers, following, post
 * dereference) derive consent from the user object they ALREADY resolve for
 * their own response body — the PURE, synchronous, Redis-write-free
 * `isFediverseSharingEnabledFromUser`. webfinger is the ONE exception: its
 * response is ALSO cached, so it does a second, UNCACHED
 * `getFediverseSharingStateByUsername` read and falls back to
 * `isFediverseSharingEnabledFromUser` on the SDK-outage ('unavailable') case
 * only. The user-inbox POST route reads `getFediverseSharingStateByUsername`
 * BEFORE verifying the HTTP signature, and proceeds on 'unavailable' (a POST
 * delivery must not be dropped for gating freshness).
 *
 * The shared inbox (`POST /ap/inbox`) is intentionally NOT covered here —
 * per-target gating for it happens inside inbox processing.
 */

const AP_ACCEPT = 'application/activity+json';
const VALID_ID = '507f1f77bcf86cd799439011';
const DOMAIN = 'mention.earth';

// A fixed throwaway RSA keypair for the user-inbox signature round-trips.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const REMOTE_ACTOR = 'https://remote.example/users/bob';
const REMOTE_KEY_ID = `${REMOTE_ACTOR}#main-key`;
const REMOTE_PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sign: HttpSignatureSigner = async (_keyId, signingString) => {
  const s = crypto.createSign('sha256');
  s.update(signingString);
  s.end();
  return s.sign(privateKey, 'base64');
};

const mocks = vi.hoisted(() => ({
  resolveOxyUser: vi.fn(),
  isFediverseSharingEnabledFromUser: vi.fn(),
  getFediverseSharingStateByUsername: vi.fn(),
  getPublicKey: vi.fn(),
  buildCreateNoteActivity: vi.fn(),
  resolveReplyContext: vi.fn(),
  resolveMentionContext: vi.fn(),
  resolveMentionContextByPost: vi.fn(),
  resolvePollContext: vi.fn(),
  resolvePollContextByPost: vi.fn(),
  resolveQuoteContext: vi.fn(),
  resolveQuoteContextByPost: vi.fn(),
  userSettingsFindOne: vi.fn(),
  postFind: vi.fn(),
  postCountDocuments: vi.fn(),
  postFindOne: vi.fn(),
  getServiceOxyClient: vi.fn(),
  getUserFollowers: vi.fn(),
  getUserFollowing: vi.fn(),
  resolveAvatarUrl: vi.fn(),
  resolveMediaRef: vi.fn(),
  fetchPublicKey: vi.fn(),
  enqueueInboxActivity: vi.fn(),
  redisGet: vi.fn(),
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../middleware/rateLimitStore', () => ({ RedisStore: class {} }));
vi.mock('../../../queue/producers', () => ({
  enqueueInboxActivity: (...args: unknown[]) => mocks.enqueueInboxActivity(...args),
}));

vi.mock('../../../connectors/activitypub/ActivityPubConnector', () => ({
  activityPubConnector: {
    buildCreateNoteActivity: (...args: unknown[]) => mocks.buildCreateNoteActivity(...args),
    resolveReplyContext: (...args: unknown[]) => mocks.resolveReplyContext(...args),
    resolveMentionContext: (...args: unknown[]) => mocks.resolveMentionContext(...args),
    resolveMentionContextByPost: (...args: unknown[]) => mocks.resolveMentionContextByPost(...args),
    resolvePollContext: (...args: unknown[]) => mocks.resolvePollContext(...args),
    resolvePollContextByPost: (...args: unknown[]) => mocks.resolvePollContextByPost(...args),
    resolveQuoteContext: (...args: unknown[]) => mocks.resolveQuoteContext(...args),
    resolveQuoteContextByPost: (...args: unknown[]) => mocks.resolveQuoteContextByPost(...args),
  },
}));

vi.mock('../../../connectors/activitypub/crypto', () => ({
  getPublicKey: (...args: unknown[]) => mocks.getPublicKey(...args),
}));

// The engine's actor router verifies inbound signatures with its OWN
// `verifyHttpSignature` (bundled), resolving the key via `actorService.fetchPublicKey`;
// mock actor.service to control that + short-circuit its heavy load chain. Every
// method is a stub — the follow/content dispatch is not exercised by the gate tests.
vi.mock('../../../connectors/activitypub/actor.service', () => ({
  actorService: {
    fetchPublicKey: (...args: unknown[]) => mocks.fetchPublicKey(...args),
    getOrFetchActor: vi.fn(),
    fetchRemoteActor: vi.fn(),
    refreshActorInBackground: vi.fn(),
    resolveActorOxyUserId: vi.fn(),
    resolveWebFinger: vi.fn(),
  },
}));

vi.mock('../../../connectors/activitypub/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../connectors/activitypub/constants')>();
  return { ...actual, resolveOxyUser: (...args: unknown[]) => mocks.resolveOxyUser(...args) };
});

vi.mock('../../../services/fediverseSharing', () => ({
  isFediverseSharingEnabledFromUser: (...args: unknown[]) =>
    mocks.isFediverseSharingEnabledFromUser(...args),
  getFediverseSharingStateByUsername: (...args: unknown[]) =>
    mocks.getFediverseSharingStateByUsername(...args),
  isFediverseSharingEnabled: vi.fn(),
}));

vi.mock('../../../utils/mediaResolver', () => ({
  resolveAvatarUrl: (...args: unknown[]) => mocks.resolveAvatarUrl(...args),
  resolveMediaRef: (...args: unknown[]) => mocks.resolveMediaRef(...args),
}));

vi.mock('../../../models/Post', () => ({
  Post: {
    countDocuments: (...args: unknown[]) => mocks.postCountDocuments(...args),
    find: (...args: unknown[]) => mocks.postFind(...args),
    findOne: (...args: unknown[]) => mocks.postFindOne(...args),
  },
}));

vi.mock('../../../models/UserSettings', () => ({
  default: { findOne: (...args: unknown[]) => mocks.userSettingsFindOne(...args) },
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: (...args: unknown[]) => mocks.getServiceOxyClient(...args),
}));

vi.mock('../../../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({ isReady: false, get: mocks.redisGet }),
}));

import apRoutes from '../../../connectors/activitypub/routes/ap.routes';
import { webfingerRouter, actorRouter } from '../../../connectors/activitypub/routes/engine.routes';

const apApp = express();
apApp.use(express.json({ type: () => true }));
apApp.use('/ap', actorRouter);
apApp.use('/ap', apRoutes);

const wellKnownApp = express();
wellKnownApp.use('/.well-known', webfingerRouter);

const RESOLVED_USER = {
  _id: 'u1',
  id: 'u1',
  username: 'alice',
  name: { displayName: 'Alice' },
  avatar: null,
  bio: '',
  createdAt: '2020-01-01T00:00:00.000Z',
  // The follow-collection summary reads the true count from the resolved profile.
  _count: { followers: 0, following: 0 },
};

/** Sign a body-less user-inbox POST (no digest) — enough to pass HTTP-sig verify. */
async function signedInboxHeaders(path: string): Promise<Record<string, string>> {
  return signRequest(sign, REMOTE_KEY_ID, 'POST', `https://${DOMAIN}${path}`);
}

const INBOX_ACTIVITY = { type: 'Follow', actor: REMOTE_ACTOR, object: 'https://mention.earth/ap/users/alice' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveOxyUser.mockResolvedValue(RESOLVED_USER);
  mocks.getPublicKey.mockResolvedValue({
    keyId: 'https://mention.earth/ap/users/alice#main-key',
    publicKeyPem: 'PEM',
  });
  mocks.fetchPublicKey.mockResolvedValue({ publicKeyPem: REMOTE_PUBLIC_PEM, actorUri: REMOTE_ACTOR });
  mocks.resolveAvatarUrl.mockReturnValue(undefined);
  mocks.resolveMediaRef.mockReturnValue({ url: undefined });
  mocks.userSettingsFindOne.mockReturnValue({ lean: async () => null });
  mocks.postCountDocuments.mockResolvedValue(0);
  mocks.postFind.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) });
  mocks.postFindOne.mockReturnValue({ lean: async () => ({ _id: VALID_ID, content: { text: 'hi' } }) });
  // The follow collections read the Oxy follow graph through the service client.
  mocks.getServiceOxyClient.mockReturnValue({
    getUserFollowers: mocks.getUserFollowers,
    getUserFollowing: mocks.getUserFollowing,
  });
  mocks.getUserFollowers.mockResolvedValue({ followers: [], total: 0, hasMore: false });
  mocks.getUserFollowing.mockResolvedValue({ following: [], total: 0, hasMore: false });
  mocks.buildCreateNoteActivity.mockReturnValue({
    '@context': ['https://www.w3.org/ns/activitystreams'],
    type: 'Create',
    object: { id: `https://mention.earth/ap/users/alice/posts/${VALID_ID}`, type: 'Note' },
  });
  mocks.resolveReplyContext.mockResolvedValue(null);
  mocks.resolveMentionContext.mockResolvedValue(null);
  mocks.resolveMentionContextByPost.mockResolvedValue(new Map());
  mocks.resolvePollContext.mockResolvedValue(null);
  mocks.resolvePollContextByPost.mockResolvedValue(new Map());
  mocks.resolveQuoteContext.mockResolvedValue(null);
  mocks.resolveQuoteContextByPost.mockResolvedValue(new Map());
  mocks.enqueueInboxActivity.mockResolvedValue(true);
  mocks.redisGet.mockResolvedValue(null);
});

const NOT_FOUND_BODY = { error: 'User not found' };

describe('fediverseSharing gates — user-scoped AP/discovery surfaces', () => {
  describe('GET /.well-known/webfinger — tri-state (UNCACHED read + FromUser outage fallback)', () => {
    const qs = '?resource=acct:alice@mention.earth';

    it("200s when getFediverseSharingStateByUsername says 'enabled'", async () => {
      mocks.getFediverseSharingStateByUsername.mockResolvedValue('enabled');
      const res = await request(wellKnownApp).get(`/.well-known/webfinger${qs}`).expect(200);
      expect(res.body.subject).toBe('acct:alice@mention.earth');
      expect(mocks.getFediverseSharingStateByUsername).toHaveBeenCalledWith('alice');
      // The uncached state read is authoritative on success — no fallback needed.
      expect(mocks.isFediverseSharingEnabledFromUser).not.toHaveBeenCalled();
    });

    it("404s with the unknown-user body when getFediverseSharingStateByUsername says 'disabled'", async () => {
      mocks.getFediverseSharingStateByUsername.mockResolvedValue('disabled');
      const res = await request(wellKnownApp).get(`/.well-known/webfinger${qs}`).expect(404);
      expect(res.body).toEqual(NOT_FOUND_BODY);
    });

    it("404s with the unknown-user body when getFediverseSharingStateByUsername says 'unknown-user'", async () => {
      mocks.getFediverseSharingStateByUsername.mockResolvedValue('unknown-user');
      const res = await request(wellKnownApp).get(`/.well-known/webfinger${qs}`).expect(404);
      expect(res.body).toEqual(NOT_FOUND_BODY);
    });

    it("'unavailable': falls back to isFediverseSharingEnabledFromUser(user) and 200s when that read says enabled — preserves GET availability through an Oxy outage", async () => {
      mocks.getFediverseSharingStateByUsername.mockResolvedValue('unavailable');
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(true);

      const res = await request(wellKnownApp).get(`/.well-known/webfinger${qs}`).expect(200);

      expect(res.body.subject).toBe('acct:alice@mention.earth');
      expect(mocks.isFediverseSharingEnabledFromUser).toHaveBeenCalledWith(RESOLVED_USER);
    });

    it("'unavailable': falls back to isFediverseSharingEnabledFromUser(user) and 404s when that read says disabled", async () => {
      mocks.getFediverseSharingStateByUsername.mockResolvedValue('unavailable');
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(false);

      const res = await request(wellKnownApp).get(`/.well-known/webfinger${qs}`).expect(404);

      expect(res.body).toEqual(NOT_FOUND_BODY);
    });
  });

  describe('GET /ap/users/:username — actor', () => {
    it('200s when sharing is enabled', async () => {
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(true);
      const res = await request(apApp).get('/ap/users/alice').set('Accept', AP_ACCEPT).expect(200);
      expect(res.body.type).toBe('Person');
      expect(mocks.isFediverseSharingEnabledFromUser).toHaveBeenCalledWith(RESOLVED_USER);
    });

    it('404s with the unknown-user body when sharing is disabled', async () => {
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(false);
      const res = await request(apApp).get('/ap/users/alice').set('Accept', AP_ACCEPT).expect(404);
      expect(res.body).toEqual(NOT_FOUND_BODY);
    });
  });

  describe('POST /ap/users/:username/inbox — user inbox', () => {
    it('202s when sharing is enabled', async () => {
      mocks.getFediverseSharingStateByUsername.mockResolvedValue('enabled');
      const headers = await signedInboxHeaders('/ap/users/alice/inbox');
      await request(apApp)
        .post('/ap/users/alice/inbox')
        .set('Content-Type', AP_ACCEPT)
        .set('X-Forwarded-Host', DOMAIN)
        .set(headers)
        .send(JSON.stringify(INBOX_ACTIVITY))
        .expect(202);
      expect(mocks.getFediverseSharingStateByUsername).toHaveBeenCalledWith('alice');
      // The gate passed → the signature was verified (the key was fetched).
      expect(mocks.fetchPublicKey).toHaveBeenCalled();
    });

    it('404s with the unknown-user body when sharing is disabled, before verifying the signature', async () => {
      mocks.getFediverseSharingStateByUsername.mockResolvedValue('disabled');
      const res = await request(apApp).post('/ap/users/alice/inbox').send(INBOX_ACTIVITY).expect(404);
      expect(res.body).toEqual(NOT_FOUND_BODY);
      expect(mocks.fetchPublicKey).not.toHaveBeenCalled();
    });

    it('404s with the unknown-user body for a genuinely unknown username, before verifying the signature', async () => {
      mocks.getFediverseSharingStateByUsername.mockResolvedValue('unknown-user');
      const res = await request(apApp).post('/ap/users/ghost/inbox').send(INBOX_ACTIVITY).expect(404);
      expect(res.body).toEqual(NOT_FOUND_BODY);
      expect(mocks.fetchPublicKey).not.toHaveBeenCalled();
    });

    it('202s and PROCEEDS when Oxy is unavailable — availability wins over gating freshness for a POST delivery', async () => {
      mocks.getFediverseSharingStateByUsername.mockResolvedValue('unavailable');
      const headers = await signedInboxHeaders('/ap/users/alice/inbox');
      await request(apApp)
        .post('/ap/users/alice/inbox')
        .set('Content-Type', AP_ACCEPT)
        .set('X-Forwarded-Host', DOMAIN)
        .set(headers)
        .send(JSON.stringify(INBOX_ACTIVITY))
        .expect(202);
      expect(mocks.fetchPublicKey).toHaveBeenCalled();
    });
  });

  describe('GET /ap/users/:username/outbox', () => {
    it('200s when sharing is enabled', async () => {
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(true);
      const res = await request(apApp).get('/ap/users/alice/outbox').set('Accept', AP_ACCEPT).expect(200);
      expect(res.body.type).toBe('OrderedCollection');
    });

    it('404s with the unknown-user body when sharing is disabled', async () => {
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(false);
      const res = await request(apApp).get('/ap/users/alice/outbox').set('Accept', AP_ACCEPT).expect(404);
      expect(res.body).toEqual(NOT_FOUND_BODY);
    });
  });

  describe('GET /ap/users/:username/collections/featured', () => {
    it('200s when sharing is enabled', async () => {
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(true);
      const res = await request(apApp)
        .get('/ap/users/alice/collections/featured')
        .set('Accept', AP_ACCEPT)
        .expect(200);
      expect(res.body.type).toBe('OrderedCollection');
    });

    it('404s with the unknown-user body when sharing is disabled, without querying posts', async () => {
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(false);
      const res = await request(apApp)
        .get('/ap/users/alice/collections/featured')
        .set('Accept', AP_ACCEPT)
        .expect(404);
      expect(res.body).toEqual(NOT_FOUND_BODY);
      expect(mocks.postFind).not.toHaveBeenCalled();
    });
  });

  describe('GET /ap/users/:username/followers', () => {
    it('200s when sharing is enabled', async () => {
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(true);
      const res = await request(apApp).get('/ap/users/alice/followers').set('Accept', AP_ACCEPT).expect(200);
      expect(res.body.type).toBe('OrderedCollection');
    });

    it('404s with the unknown-user body when sharing is disabled', async () => {
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(false);
      const res = await request(apApp).get('/ap/users/alice/followers').set('Accept', AP_ACCEPT).expect(404);
      expect(res.body).toEqual(NOT_FOUND_BODY);
    });
  });

  describe('GET /ap/users/:username/following', () => {
    it('200s when sharing is enabled', async () => {
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(true);
      const res = await request(apApp).get('/ap/users/alice/following').set('Accept', AP_ACCEPT).expect(200);
      expect(res.body.type).toBe('OrderedCollection');
    });

    it('404s with the unknown-user body when sharing is disabled', async () => {
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(false);
      const res = await request(apApp).get('/ap/users/alice/following').set('Accept', AP_ACCEPT).expect(404);
      expect(res.body).toEqual(NOT_FOUND_BODY);
    });
  });

  describe('GET /ap/users/:username/posts/:id — dereference (serves user content)', () => {
    it('200s when sharing is enabled', async () => {
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(true);
      await request(apApp).get(`/ap/users/alice/posts/${VALID_ID}`).set('Accept', AP_ACCEPT).expect(200);
    });

    it('404s with the unknown-user body when sharing is disabled', async () => {
      mocks.isFediverseSharingEnabledFromUser.mockReturnValue(false);
      const res = await request(apApp)
        .get(`/ap/users/alice/posts/${VALID_ID}`)
        .set('Accept', AP_ACCEPT)
        .expect(404);
      expect(res.body).toEqual(NOT_FOUND_BODY);
      expect(mocks.postFindOne).not.toHaveBeenCalled();
    });
  });
});
