import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Viewing an empty Instagram-identity profile.
 *
 * The kilogram bridge's outbox is ALWAYS an empty collection, so the ordinary
 * outbox rule ("pending again once the 15-minute cooldown lapses") made such a
 * profile flicker between a spinner and empty forever. With the Graph connector
 * on, the Graph sync decides: pending only until a first sync has finished.
 */

const h = vi.hoisted(() => ({
  findActorByOxyUserId: vi.fn(),
  syncInBackground: vi.fn(),
  syncOutboxPostsDetailed: vi.fn(async () => ({ syncedCount: 0, shouldStampCooldown: true })),
  fetchRemoteActor: vi.fn(async () => null),
}));

vi.mock('../../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      instagramGraph: { enabled: true, businessAccountId: '17841400000000000', apiVersion: 'v23.0', followBackfillLimit: 50 },
    },
    getMetaGraphAccessToken: () => 'test-token',
  };
});
vi.mock('../../../connectors/activitypub/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../connectors/activitypub/constants')>()),
  FEDERATION_ENABLED: true,
}));
vi.mock('../../../connectors/activitypub/ActivityPubConnector', () => ({
  activityPubConnector: {
    fetchRemoteActor: h.fetchRemoteActor,
    refreshActorInBackground: vi.fn(),
    syncOutboxPostsDetailed: h.syncOutboxPostsDetailed,
    markOutboxBackfillUnavailable: vi.fn(),
  },
  isPermanentlyUnavailableOutboxReason: () => false,
}));
vi.mock('../../../db/federation/actorRepository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/federation/actorRepository')>()),
  findActorByOxyUserId: h.findActorByOxyUserId,
  stampLastOutboxSyncAt: vi.fn(),
  setActorOxyUserId: vi.fn(),
}));
vi.mock('../../../connectors/instagram/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../connectors/instagram/sync')>()),
  requestInstagramSync: h.syncInBackground,
}));
vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ users: { get: vi.fn(async () => ({ id: 'oxy-zuck', type: 'federated', username: 'zuck@instagram.com' })) } }),
}));

import { config } from '../../../config';
import { federatedProfileSync } from '../../../connectors/federatedProfileSync';

const MINUTE = 60_000;

function kilogramActor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    protocol: 'activitypub',
    uri: 'https://kilogram.makeup/users/zuck',
    username: 'zuck',
    domain: 'kilogram.makeup',
    acct: 'zuck@kilogram.makeup',
    networkAcct: 'zuck@instagram.com',
    outboxUrl: 'https://kilogram.makeup/users/zuck/outbox',
    oxyUserId: 'oxy-zuck',
    lastFetchedAt: new Date(),
    outboxBackfill: {},
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  vi.clearAllMocks();
  config.instagramGraph.enabled = true;
});

describe('an Instagram-identity profile view', () => {
  it('starts a Graph sync and asks the reader to wait while none has ever finished', async () => {
    h.findActorByOxyUserId.mockResolvedValue(kilogramActor());
    expect(await federatedProfileSync.syncOnProfileView('oxy-zuck')).toBe(true);
    await flush();
    expect(h.syncInBackground).toHaveBeenCalledWith(expect.objectContaining({ uri: 'https://kilogram.makeup/users/zuck' }), 'profile_view');
  });

  it('does NOT flicker back to pending after the outbox cooldown once a Graph sync has finished', async () => {
    h.findActorByOxyUserId.mockResolvedValue(kilogramActor({
      lastOutboxSyncAt: new Date(Date.now() - 20 * MINUTE),
      instagramGraphSyncedAt: new Date(Date.now() - 20 * MINUTE),
    }));
    expect(await federatedProfileSync.syncOnProfileView('oxy-zuck')).toBe(false);
  });

  it('with the Graph connector off, stops waiting once the (empty) bridge outbox has been read', async () => {
    config.instagramGraph.enabled = false;
    h.findActorByOxyUserId.mockResolvedValue(kilogramActor({ lastOutboxSyncAt: new Date(Date.now() - 20 * MINUTE) }));
    expect(await federatedProfileSync.syncOnProfileView('oxy-zuck')).toBe(false);
    await flush();
    expect(h.syncInBackground).not.toHaveBeenCalled();
  });

  it('never runs the ActivityPub outbox dance for a Graph-only actor', async () => {
    h.findActorByOxyUserId.mockResolvedValue(kilogramActor({
      protocol: 'instagram-graph',
      uri: 'instagram-graph:17841401746480004',
      domain: 'instagram.com',
      outboxUrl: undefined,
    }));
    await federatedProfileSync.syncOnProfileView('oxy-zuck');
    await flush();
    expect(h.syncInBackground).toHaveBeenCalledTimes(1);
    expect(h.fetchRemoteActor).not.toHaveBeenCalled();
    expect(h.syncOutboxPostsDetailed).not.toHaveBeenCalled();
  });

  it('leaves an ordinary fediverse actor on the outbox rule', async () => {
    h.findActorByOxyUserId.mockResolvedValue(kilogramActor({
      uri: 'https://mastodon.example/users/alice',
      networkAcct: undefined,
      lastOutboxSyncAt: new Date(Date.now() - 20 * MINUTE),
    }));
    expect(await federatedProfileSync.syncOnProfileView('oxy-alice')).toBe(true);
    await flush();
    expect(h.syncInBackground).not.toHaveBeenCalled();
  });
});
