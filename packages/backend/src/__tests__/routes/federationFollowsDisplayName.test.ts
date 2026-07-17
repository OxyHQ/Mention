import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract test for `GET /federation/following` and `GET /federation/followers`.
 *
 * Display names are owned by the Oxy API (`name.displayName`) and are the SINGLE
 * source of truth. These routes MUST batch-resolve each remote actor's Oxy user
 * by `oxyUserId` and emit the Oxy `name.displayName` — never a local
 * `FederatedActor` name copy (that field has been deleted). When an actor's Oxy
 * user is missing from the response, the route falls back to the `@<acct>` handle.
 */

const { followFind, actorFind, getUsersByIds } = vi.hoisted(() => ({
  followFind: vi.fn(),
  actorFind: vi.fn(),
  getUsersByIds: vi.fn(),
}));

// The route module imports the server entrypoint and the connector registry
// transitively (ActivityPub + atproto connectors, PostHydrationService); stub the
// heavy/circular deps so it can be imported in isolation — same pattern as
// profileDesign.test.ts.
vi.mock('../../../server', () => ({ oxy: {} }));

vi.mock('@oxyhq/core/server', () => ({
  getRequiredOxyUserId: () => 'local-user-1',
}));

vi.mock('../../connectors/activitypub/constants', () => ({
  FEDERATION_ENABLED: true,
  // `actorObject.ts` / `actor.service.ts` / `delivery.service.ts` bind the shared
  // engine at module load, so they read these from constants when this module graph
  // is imported (connectors.routes → sharingCleanup.service → delivery.service).
  isBlockedDomain: () => false,
  FEDERATION_DOMAIN: 'mention.earth',
  AP_CONTENT_TYPE: 'application/activity+json',
  USER_AGENT: 'Mention/mention.earth (ActivityPub)',
  resolveOxyUser: vi.fn(),
  federationUrls: {
    actor: (u: string) => `https://mention.earth/ap/users/${u}`,
    inbox: (u: string) => `https://mention.earth/ap/users/${u}/inbox`,
    outbox: (u: string) => `https://mention.earth/ap/users/${u}/outbox`,
    featured: (u: string) => `https://mention.earth/ap/users/${u}/collections/featured`,
    followers: (u: string) => `https://mention.earth/ap/users/${u}/followers`,
    following: (u: string) => `https://mention.earth/ap/users/${u}/following`,
    sharedInbox: () => 'https://mention.earth/ap/inbox',
  },
}));
vi.mock('../../connectors/atproto/constants', () => ({ ATPROTO_ENABLED: false }));

// The connector registry + resolve classifier pull the full connector graph;
// these list-only routes never invoke them, so stub them out.
vi.mock('../../connectors/index', () => ({
  connectorRegistry: {
    list: () => [],
    connectorFor: () => undefined,
    resolve: vi.fn(async () => null),
  },
}));
vi.mock('../../connectors/resolve', () => ({ classifyQuery: vi.fn(() => 'activitypub') }));

vi.mock('../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../connectors/activitypub/ActivityPubConnector', () => ({
  activityPubConnector: {},
  isPermanentlyUnavailableOutboxReason: vi.fn(() => false),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(),
  getServiceOxyClient: () => ({ getUsersByIds }),
}));

vi.mock('../../models/Post', () => ({ Post: { find: vi.fn() } }));

function leanable(rows: unknown[]) {
  return { lean: async () => rows };
}

vi.mock('../../models/FederatedFollow', () => ({
  default: { find: (...args: unknown[]) => leanable(followFind(...args)) },
}));

vi.mock('../../models/FederatedActor', () => ({
  default: { find: (...args: unknown[]) => leanable(actorFind(...args)) },
}));

import federationApiRoutes from '../../connectors/connectors.routes';

interface FollowResult {
  actorUri: string;
  handle: string;
  instance: string;
  fullHandle: string;
  displayName: string;
  avatarUrl?: string;
  isFollowing?: boolean;
  isFollowPending?: boolean;
}

const app = express();
app.use(express.json());
app.use('/federation', federationApiRoutes);

function oxyUser(id: string, displayName: string) {
  return { id, username: `${id}-handle`, name: { displayName }, verified: false };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /federation/following — Oxy name.displayName', () => {
  it('returns the Oxy name.displayName for each followed remote actor', async () => {
    followFind.mockReturnValue([
      { remoteActorUri: 'https://remote.example/users/alice', status: 'accepted' },
      { remoteActorUri: 'https://remote.example/users/bob', status: 'pending' },
    ]);
    actorFind.mockReturnValue([
      { uri: 'https://remote.example/users/alice', username: 'alice', domain: 'remote.example', acct: 'alice@remote.example', oxyUserId: 'oxy-alice', avatarUrl: 'a.png' },
      { uri: 'https://remote.example/users/bob', username: 'bob', domain: 'remote.example', acct: 'bob@remote.example', oxyUserId: 'oxy-bob', avatarUrl: 'b.png' },
    ]);
    getUsersByIds.mockResolvedValue([
      oxyUser('oxy-alice', 'Alice Clean'),
      oxyUser('oxy-bob', 'Bob Clean'),
    ]);

    const res = await request(app).get('/federation/following').expect(200);

    expect(getUsersByIds).toHaveBeenCalledWith(expect.arrayContaining(['oxy-alice', 'oxy-bob']));
    const byUri = new Map(
      (res.body.following as FollowResult[]).map((f) => [f.actorUri, f]),
    );
    expect(byUri.get('https://remote.example/users/alice')?.displayName).toBe('Alice Clean');
    expect(byUri.get('https://remote.example/users/bob')?.displayName).toBe('Bob Clean');
    expect(byUri.get('https://remote.example/users/alice')?.isFollowing).toBe(true);
    expect(byUri.get('https://remote.example/users/bob')?.isFollowPending).toBe(true);
  });

  it('falls back to the @acct handle when the Oxy user is missing from the response', async () => {
    followFind.mockReturnValue([
      { remoteActorUri: 'https://remote.example/users/ghost', status: 'accepted' },
    ]);
    actorFind.mockReturnValue([
      { uri: 'https://remote.example/users/ghost', username: 'ghost', domain: 'remote.example', acct: 'ghost@remote.example', oxyUserId: 'oxy-ghost' },
    ]);
    // Oxy returns no user for oxy-ghost.
    getUsersByIds.mockResolvedValue([]);

    const res = await request(app).get('/federation/following').expect(200);

    const [first] = res.body.following as FollowResult[];
    expect(first.displayName).toBe('@ghost@remote.example');
  });
});

describe('GET /federation/followers — Oxy name.displayName', () => {
  it('returns the Oxy name.displayName for each remote follower', async () => {
    followFind.mockReturnValue([
      { remoteActorUri: 'https://remote.example/users/carol', status: 'accepted' },
    ]);
    actorFind.mockReturnValue([
      { uri: 'https://remote.example/users/carol', username: 'carol', domain: 'remote.example', acct: 'carol@remote.example', oxyUserId: 'oxy-carol', avatarUrl: 'c.png' },
    ]);
    getUsersByIds.mockResolvedValue([oxyUser('oxy-carol', 'Carol Clean')]);

    const res = await request(app).get('/federation/followers').expect(200);

    const [first] = res.body.followers as FollowResult[];
    expect(first.displayName).toBe('Carol Clean');
    expect(first.fullHandle).toBe('@carol@remote.example');
  });
});
