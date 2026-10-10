import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Instagram connector at its seams: which subjects the registry routes to
 * it, how an `instagram-graph` identity from Oxy is parsed and cached, the
 * `/federation/resolve` and `/federation/actor/posts` paths, and the flag that
 * makes all of it inert.
 */

const GRAPH_ACTOR = 'instagram-graph:17841401746480004';
const KILOGRAM_ACTOR = 'https://kilogram.makeup/users/zuck';

const h = vi.hoisted(() => ({
  serviceRequest: vi.fn(),
  upsertActor: vi.fn(),
  findActorByUri: vi.fn(),
  findPostRecords: vi.fn(),
  reconcile: vi.fn(),
  syncInBackground: vi.fn(),
  syncInstagramActor: vi.fn(),
}));

vi.mock('../../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      instagramGraph: {
        enabled: true,
        businessAccountId: '17841400000000000',
        apiVersion: 'v23.0',
        followBackfillLimit: 50,
      },
    },
    getMetaGraphAccessToken: () => 'test-token',
  };
});

vi.mock('../../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(),
  getServiceOxyClient: () => ({
    serviceRequest: h.serviceRequest,
    users: { get: vi.fn(), getMany: vi.fn(async () => []) },
  }),
}));

vi.mock('../../../db/federation/actorRepository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/federation/actorRepository')>()),
  upsertActor: h.upsertActor,
  findActorByUri: h.findActorByUri,
}));
vi.mock('../../../db/posts/postRepository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/posts/postRepository')>()),
  findPostRecords: h.findPostRecords,
}));
vi.mock('../../../services/ActorIdentityProjectionService', () => ({
  reconcileActorIdentityProjection: h.reconcile,
}));
vi.mock('../../../services/userSummaryCache', () => ({ invalidate: vi.fn() }));
vi.mock('../../../connectors/instagram/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../connectors/instagram/sync')>()),
  requestInstagramSync: h.syncInBackground,
  syncInstagramActor: h.syncInstagramActor,
}));
vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
  getRequiredOxyUserId: () => 'local-user-1',
}));
vi.mock('../../../middleware/rateLimiter', () => ({
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
}));
vi.mock('../../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: vi.fn(async () => true),
  invalidateFediverseSharing: vi.fn(),
}));

import { config } from '../../../config';
import { ConnectorRegistry } from '../../../connectors/ConnectorRegistry';
import { activityPubConnector } from '../../../connectors/activitypub/ActivityPubConnector';
import { atprotoConnector } from '../../../connectors/atproto/AtprotoConnector';
import { instagramGraphConnector } from '../../../connectors/instagram/InstagramGraphConnector';
import { connectorRegistry } from '../../../connectors/index';
import connectorsRoutes from '../../../connectors/connectors.routes';
import { resolveOxyIdentity } from '../../../connectors/oxyIdentity';
import { resolveExternalIdentityResponseSchema } from '@oxy.so/contracts';
import { oxyIdentityFixture } from '../../helpers/oxyIdentityFixtures';

const app = express();
app.use(express.json());
app.use('/federation', connectorsRoutes);

function graphIdentity() {
  return oxyIdentityFixture({
    actorUri: GRAPH_ACTOR,
    transportAcct: 'zuck@instagram.com',
    canonicalAcct: 'zuck@instagram.com',
    network: 'instagram.com',
    protocol: 'instagram-graph',
    userId: 'oxy-zuck',
    displayName: 'Mark Zuckerberg',
    bio: 'I build stuff',
  });
}

function actorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    protocol: 'activitypub',
    uri: KILOGRAM_ACTOR,
    username: 'zuck',
    domain: 'kilogram.makeup',
    acct: 'zuck@kilogram.makeup',
    networkAcct: 'zuck@instagram.com',
    outboxUrl: `${KILOGRAM_ACTOR}/outbox`,
    oxyUserId: 'oxy-zuck',
    outboxBackfill: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  config.instagramGraph.enabled = true;
  h.reconcile.mockResolvedValue({});
  h.upsertActor.mockImplementation(async (uri: string, columns: Record<string, unknown>) => ({
    id: 'row-g',
    uri,
    ...columns,
  }));
  h.findPostRecords.mockResolvedValue([]);
});

describe('routing instagram-graph URIs', () => {
  it('neither the ActivityPub nor the atproto connector claims one', () => {
    expect(activityPubConnector.matches(GRAPH_ACTOR)).toBe(false);
    expect(atprotoConnector.matches(GRAPH_ACTOR)).toBe(false);
    expect(instagramGraphConnector.matches(GRAPH_ACTOR)).toBe(true);
    expect(instagramGraphConnector.matches('instagram-graph:not-a-number')).toBe(false);
    expect(instagramGraphConnector.matches(KILOGRAM_ACTOR)).toBe(false);
  });

  it('goes to the Instagram connector whatever the registration order — even behind a greedy connector', () => {
    const greedy = {
      ...activityPubConnector,
      id: 'activitypub' as const,
      enabled: true,
      matches: () => true,
    };
    const registry = new ConnectorRegistry([greedy, atprotoConnector, instagramGraphConnector]);
    expect(registry.connectorFor(GRAPH_ACTOR)?.id).toBe('instagram-graph');
    expect(registry.connectorFor(KILOGRAM_ACTOR)?.id).toBe('activitypub');
  });

  it('is registered in the live registry when enabled', () => {
    expect(connectorRegistry.connectorFor(GRAPH_ACTOR)?.id).toBe('instagram-graph');
  });
});

describe('parsing an instagram-graph identity from Oxy (@oxy.so/contracts 4)', () => {
  it('accepts and keeps the instagram-graph protocol', () => {
    const parsed = resolveExternalIdentityResponseSchema.parse(graphIdentity());
    expect(parsed.externalIdentity.protocol).toBe('instagram-graph');
    expect(parsed.externalIdentities[0].protocol).toBe('instagram-graph');
    expect(parsed.user.externalIdentities[0].protocol).toBe('instagram-graph');
  });

  it('rejects any other unknown protocol', () => {
    const body = graphIdentity();
    body.externalIdentity.protocol = 'smoke-signals' as 'instagram-graph';
    expect(() => resolveExternalIdentityResponseSchema.parse(body)).toThrow();
  });

  it('runs the published refinements', () => {
    const body = graphIdentity();
    body.externalIdentity.userId = 'somebody-else';
    expect(() => resolveExternalIdentityResponseSchema.parse(body)).toThrow();
  });

  it('asks Oxy with protocol instagram-graph', async () => {
    h.serviceRequest.mockResolvedValue(graphIdentity());
    await resolveOxyIdentity({ actorUri: GRAPH_ACTOR, protocol: 'instagram-graph' });
    expect(h.serviceRequest).toHaveBeenCalledWith('POST', '/federation/identities/resolve', {
      actorUri: GRAPH_ACTOR,
      protocol: 'instagram-graph',
    });
  });
});

describe('caching an instagram-graph actor', () => {
  it('upserts protocol instagram-graph under instagram.com, from Oxy — no Graph call', async () => {
    h.serviceRequest.mockResolvedValue(graphIdentity());
    const actor = await instagramGraphConnector.fetchProfile(GRAPH_ACTOR);

    expect(actor).toMatchObject({
      network: 'instagram-graph',
      externalId: GRAPH_ACTOR,
      handle: 'zuck@instagram.com',
      oxyUserId: 'oxy-zuck',
      bio: 'I build stuff',
    });
    expect(h.upsertActor).toHaveBeenCalledWith(
      GRAPH_ACTOR,
      expect.objectContaining({
        protocol: 'instagram-graph',
        username: 'zuck',
        domain: 'instagram.com',
        acct: 'zuck@instagram.com',
        networkAcct: 'zuck@instagram.com',
      }),
      [],
    );
    expect(h.reconcile).toHaveBeenCalledWith({
      actorUri: GRAPH_ACTOR,
      oxyUserId: 'oxy-zuck',
      networkAcct: 'zuck@instagram.com',
    });
  });

  it('resolves through /federation/resolve end to end', async () => {
    h.serviceRequest.mockResolvedValue(graphIdentity());
    const res = await request(app)
      .get('/federation/resolve')
      .query({ handle: 'https://www.instagram.com/zuck/' });

    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({
      network: 'instagram-graph',
      externalId: GRAPH_ACTOR,
      handle: 'zuck@instagram.com',
      oxyUserId: 'oxy-zuck',
    });
  });
});

describe('/federation/actor/posts on an empty Instagram profile', () => {
  it('starts a Graph sync for a kilogram actor and reports syncing until one has finished', async () => {
    h.findActorByUri.mockResolvedValue(actorRow());
    const res = await request(app).get('/federation/actor/posts').query({ uri: KILOGRAM_ACTOR });
    expect(res.body).toMatchObject({ posts: [], syncing: true });
    expect(h.syncInBackground).toHaveBeenCalledWith(
      expect.objectContaining({ uri: KILOGRAM_ACTOR }),
      'profile_view',
    );
  });

  it('stops reporting syncing once a sync has finished — no flicker', async () => {
    h.findActorByUri.mockResolvedValue(
      actorRow({ instagramGraphSyncedAt: new Date(Date.now() - 86_400_000) }),
    );
    const res = await request(app).get('/federation/actor/posts').query({ uri: KILOGRAM_ACTOR });
    expect(res.body).toMatchObject({ posts: [], syncing: false });
  });

  it('accepts an instagram-graph actor URI', async () => {
    h.findActorByUri.mockResolvedValue(
      actorRow({ protocol: 'instagram-graph', uri: GRAPH_ACTOR, outboxUrl: undefined }),
    );
    const res = await request(app).get('/federation/actor/posts').query({ uri: GRAPH_ACTOR });
    expect(res.status).toBe(200);
    expect(res.body.syncing).toBe(true);
  });
});

describe('with the flag off', () => {
  it('is fully inert', async () => {
    config.instagramGraph.enabled = false;
    expect(instagramGraphConnector.enabled).toBe(false);
    expect(await instagramGraphConnector.fetchProfile(GRAPH_ACTOR)).toBeNull();
    expect(await instagramGraphConnector.fetchPosts(GRAPH_ACTOR)).toEqual({ posts: [] });
    expect(instagramGraphConnector.isProfileSyncPending(actorRow() as never)).toBe(false);
    instagramGraphConnector.syncOnProfileView(actorRow() as never);
    await instagramGraphConnector.backfillOnFollow(KILOGRAM_ACTOR);
    expect(h.serviceRequest).not.toHaveBeenCalled();
    expect(h.syncInBackground).not.toHaveBeenCalled();
    expect(h.syncInstagramActor).not.toHaveBeenCalled();
  });

  it('leaves a kilogram profile on the ActivityPub path', async () => {
    config.instagramGraph.enabled = false;
    h.findActorByUri.mockResolvedValue(actorRow({ outboxUrl: undefined }));
    const res = await request(app).get('/federation/actor/posts').query({ uri: KILOGRAM_ACTOR });
    expect(res.status).toBe(200);
    expect(h.syncInBackground).not.toHaveBeenCalled();
  });
});
