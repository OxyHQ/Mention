import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedFollow,
} from '../helpers/federationFixtures';

const scope = federationScope('federation-follows-display-name');

/**
 * Contract test for `GET /federation/following` and `GET /federation/followers`.
 *
 * Display names are owned by the Oxy API (`name.displayName`) and are the SINGLE
 * source of truth. These routes MUST batch-resolve each remote actor's Oxy user
 * by `oxyUserId` and emit the Oxy `name.displayName` — never a local
 * `FederatedActor` name copy (that field has been deleted). When an actor's Oxy
 * user is missing from the response, the route falls back to the `@<acct>` handle.
 */

const { getUsersByIds } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
}));

// The route module imports the server entrypoint and the connector registry
// transitively (ActivityPub + atproto connectors, PostHydrationService); stub the
// heavy/circular deps so it can be imported in isolation — same pattern as
// profileDesign.test.ts.
vi.mock('../../runtime/oxyClient', () => ({ getRuntimeOxyClient: () => ({}) }));

// The viewer id the routes filter their follow rows by. It has to be the SCOPE's
// local user now that the query is real: the previous fake ignored the filter
// entirely and returned its rows to whoever asked.
vi.mock('@oxyhq/core/server', () => ({
  getRequiredOxyUserId: () => `oxy-local-federation-follows-display-name`,
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

function leanable(rows: unknown[]) {
  return { lean: async () => rows };
}

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

/** One remote actor + the viewer's edge to it, as real rows. */
async function seedFollowedActor(
  username: string,
  oxyUserId: string,
  options: { direction?: 'inbound' | 'outbound'; status?: 'accepted' | 'pending'; avatarUrl?: string } = {},
): Promise<string> {
  const uri = `${scope.origin}/users/${username}`;
  await seedActor(scope, { username, uri, oxyUserId, avatarUrl: options.avatarUrl ?? null });
  await seedFollow(scope, {
    remoteActorUri: uri,
    direction: options.direction ?? 'outbound',
    status: options.status ?? 'accepted',
  });
  return uri;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFederationScope(scope);
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /federation/following — Oxy name.displayName', () => {
  it('returns the Oxy name.displayName for each followed remote actor', async () => {
    const aliceUri = await seedFollowedActor('alice', 'oxy-alice', { avatarUrl: 'a.png' });
    const bobUri = await seedFollowedActor('bob', 'oxy-bob', { status: 'pending', avatarUrl: 'b.png' });
    getUsersByIds.mockResolvedValue([
      oxyUser('oxy-alice', 'Alice Clean'),
      oxyUser('oxy-bob', 'Bob Clean'),
    ]);

    const res = await request(app).get('/federation/following').expect(200);

    expect(getUsersByIds).toHaveBeenCalledWith(expect.arrayContaining(['oxy-alice', 'oxy-bob']));
    const byUri = new Map(
      (res.body.following as FollowResult[]).map((f) => [f.actorUri, f]),
    );
    expect(byUri.get(aliceUri)?.displayName).toBe('Alice Clean');
    expect(byUri.get(bobUri)?.displayName).toBe('Bob Clean');
    expect(byUri.get(aliceUri)?.isFollowing).toBe(true);
    expect(byUri.get(bobUri)?.isFollowPending).toBe(true);
  });

  it('falls back to the @acct handle when the Oxy user is missing from the response', async () => {
    await seedFollowedActor('ghost', 'oxy-ghost');
    // Oxy returns no user for oxy-ghost.
    getUsersByIds.mockResolvedValue([]);

    const res = await request(app).get('/federation/following').expect(200);

    const [first] = res.body.following as FollowResult[];
    expect(first.displayName).toBe(`@ghost@${scope.domain}`);
  });
});

describe('GET /federation/followers — Oxy name.displayName', () => {
  it('returns the Oxy name.displayName for each remote follower', async () => {
    await seedFollowedActor('carol', 'oxy-carol', { direction: 'inbound', avatarUrl: 'c.png' });
    getUsersByIds.mockResolvedValue([oxyUser('oxy-carol', 'Carol Clean')]);

    const res = await request(app).get('/federation/followers').expect(200);

    const [first] = res.body.followers as FollowResult[];
    expect(first.displayName).toBe('Carol Clean');
    expect(first.fullHandle).toBe(`@carol@${scope.domain}`);
  });
});
