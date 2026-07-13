import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract test for the `fediverseSharing` gate on `POST /federation/follow`
 * and `POST /federation/unfollow`.
 *
 * These two routes are the only production callers that build `follow.add` /
 * `follow.remove` `LocalNetworkEvent`s, and they call `connector.deliver(event)`
 * DIRECTLY — bypassing `ConnectorRegistry.deliver`'s own gate (see
 * `connectorRegistrySharingGate.test.ts`). So they need their own
 * `isFediverseSharingEnabled` check right after the caller resolves, before any
 * connector is reached: a sharing-off user must not be able to send an outbound
 * Follow OR Undo(Follow) — even an Undo is unverifiable by the remote server
 * once the actor 404s, so there is no unfollow carve-out.
 */

const { isFediverseSharingEnabled, connectorFor, deliver, getUserById } = vi.hoisted(() => ({
  isFediverseSharingEnabled: vi.fn(),
  connectorFor: vi.fn(),
  deliver: vi.fn(),
  getUserById: vi.fn(),
}));

// Same isolation strategy as `federationFollowsDisplayName.test.ts`: the route
// module transitively imports the server entrypoint and the full connector
// registry graph — stub the heavy/circular deps so it loads standalone.
vi.mock('../../../server', () => ({ oxy: { getUserById } }));

vi.mock('@oxyhq/core/server', () => ({
  getRequiredOxyUserId: () => 'local-user-1',
}));

vi.mock('../../connectors/activitypub/constants', () => ({ FEDERATION_ENABLED: true }));
vi.mock('../../connectors/atproto/constants', () => ({ ATPROTO_ENABLED: false }));

vi.mock('../../connectors/index', () => ({
  connectorRegistry: {
    list: () => [],
    connectorFor: (...args: unknown[]) => connectorFor(...args),
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
  getServiceOxyClient: () => ({ getUserById }),
}));

vi.mock('../../models/Post', () => ({ Post: { find: vi.fn() } }));

vi.mock('../../models/FederatedFollow', () => ({
  default: { find: vi.fn(() => ({ lean: async () => [] })) },
}));

vi.mock('../../models/FederatedActor', () => ({
  // Both `resolveTargetConnector`'s stored-protocol lookup and the follow
  // route's post-deliver read-back chain `.select(...).lean()`; a stored actor
  // is irrelevant to the sharing gate itself, so every call resolves `null`
  // and dispatch falls through to `connectorFor`.
  default: { findOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })) },
}));

vi.mock('../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: (...args: unknown[]) => isFediverseSharingEnabled(...args),
}));

import connectorsRoutes from '../../connectors/connectors.routes';

const app = express();
app.use(express.json());
app.use('/federation', connectorsRoutes);

const TARGET_ACTOR_URI = 'https://remote.example/users/bob';
const DISABLED_BODY = { error: 'Fediverse sharing is disabled' };

beforeEach(() => {
  vi.clearAllMocks();
  connectorFor.mockReturnValue({ deliver });
  deliver.mockResolvedValue(undefined);
  getUserById.mockResolvedValue({ username: 'nate' });
});

describe('POST /federation/follow — fediverseSharing gate', () => {
  it('delivers the follow.add event when sharing is enabled', async () => {
    isFediverseSharingEnabled.mockResolvedValue(true);

    const res = await request(app)
      .post('/federation/follow')
      .send({ actorUri: TARGET_ACTOR_URI })
      .expect(200);

    expect(isFediverseSharingEnabled).toHaveBeenCalledWith('local-user-1');
    expect(res.body.success).toBe(true);
    expect(deliver).toHaveBeenCalledWith({
      kind: 'follow.add',
      localOxyUserId: 'local-user-1',
      localUsername: 'nate',
      targetActorUri: TARGET_ACTOR_URI,
    });
  });

  it('403s and never reaches the connector when sharing is disabled', async () => {
    isFediverseSharingEnabled.mockResolvedValue(false);

    const res = await request(app)
      .post('/federation/follow')
      .send({ actorUri: TARGET_ACTOR_URI })
      .expect(403);

    expect(res.body).toEqual(DISABLED_BODY);
    expect(isFediverseSharingEnabled).toHaveBeenCalledWith('local-user-1');
    expect(connectorFor).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });
});

describe('POST /federation/unfollow — fediverseSharing gate', () => {
  it('delivers the follow.remove event when sharing is enabled', async () => {
    isFediverseSharingEnabled.mockResolvedValue(true);

    const res = await request(app)
      .post('/federation/unfollow')
      .send({ actorUri: TARGET_ACTOR_URI })
      .expect(200);

    expect(isFediverseSharingEnabled).toHaveBeenCalledWith('local-user-1');
    expect(res.body.success).toBe(true);
    expect(deliver).toHaveBeenCalledWith({
      kind: 'follow.remove',
      localOxyUserId: 'local-user-1',
      localUsername: 'nate',
      targetActorUri: TARGET_ACTOR_URI,
    });
  });

  it('403s and never reaches the connector when sharing is disabled (no unfollow carve-out)', async () => {
    isFediverseSharingEnabled.mockResolvedValue(false);

    const res = await request(app)
      .post('/federation/unfollow')
      .send({ actorUri: TARGET_ACTOR_URI })
      .expect(403);

    expect(res.body).toEqual(DISABLED_BODY);
    expect(isFediverseSharingEnabled).toHaveBeenCalledWith('local-user-1');
    expect(connectorFor).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });
});
