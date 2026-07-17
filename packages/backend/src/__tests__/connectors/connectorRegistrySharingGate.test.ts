import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The outbound seam: EVERY local domain event (`post.create`, `follow.add`,
 * `follow.remove`) fans out to enabled connectors through `ConnectorRegistry`,
 * gated FIRST on the acting user's `fediverseSharing` consent
 * (`isFediverseSharingEnabled`) so an OFF user never leaks a post/follow to ANY
 * connector. `federateNewPost` is a thin `post.create` wrapper over the same
 * `deliver` seam — see `connectorRegistry.test.ts` for the fan-out/isolation
 * behavior (best-effort `Promise.allSettled`, per-connector rejection logging,
 * disabled-connector skip), which this file does not re-test.
 */

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    error: mocks.loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: mocks.loggerDebug,
  },
}));

vi.mock('../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: (...args: unknown[]) => mocks.isFediverseSharingEnabled(...args),
}));

import { ConnectorRegistry } from '../../connectors/ConnectorRegistry';
import type { PostContent } from '@mention/shared-types';
import type { NetworkConnector, NetworkId, LocalPostEventPayload } from '@oxyhq/federation';

/** A minimal fake connector with an overridable, spy-able `deliver`. */
function makeConnector(id: NetworkId, deliver: NetworkConnector<PostContent>['deliver'], enabled = true): NetworkConnector<PostContent> {
  return {
    id,
    enabled,
    matches: vi.fn().mockReturnValue(false),
    resolve: vi.fn().mockResolvedValue(null),
    fetchProfile: vi.fn().mockResolvedValue(null),
    fetchPosts: vi.fn().mockResolvedValue({ posts: [] }),
    deliver,
    receive: vi.fn().mockResolvedValue(undefined),
    mapIdentity: vi.fn().mockResolvedValue(null),
  };
}

const POST: LocalPostEventPayload<PostContent> = {
  _id: 'p1',
  content: { text: 'hello' },
  visibility: 'public',
  createdAt: '2024-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConnectorRegistry.federateNewPost (post.create) — sharing gate', () => {
  it('does not call the connector when sharing is off for the acting user', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);
    const deliver = vi.fn().mockResolvedValue(undefined);
    const registry = new ConnectorRegistry([makeConnector('activitypub', deliver)]);

    await registry.federateNewPost(POST, 'u1', 'nate');

    expect(mocks.isFediverseSharingEnabled).toHaveBeenCalledWith('u1');
    expect(deliver).not.toHaveBeenCalled();
    expect(mocks.loggerDebug).toHaveBeenCalledWith(expect.stringContaining('u1'));
  });

  it('calls the connector when sharing is on for the acting user', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(true);
    const deliver = vi.fn().mockResolvedValue(undefined);
    const registry = new ConnectorRegistry([makeConnector('activitypub', deliver)]);

    await registry.federateNewPost(POST, 'u1', 'nate');

    expect(mocks.isFediverseSharingEnabled).toHaveBeenCalledWith('u1');
    expect(deliver).toHaveBeenCalledWith({
      kind: 'post.create',
      post: POST,
      actorOxyUserId: 'u1',
      actorUsername: 'nate',
    });
  });
});

describe('ConnectorRegistry.deliver (follow.add / follow.remove) — sharing gate', () => {
  it('does not call the connector for follow.add when sharing is off for the local acting user', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);
    const deliver = vi.fn().mockResolvedValue(undefined);
    const registry = new ConnectorRegistry([makeConnector('activitypub', deliver)]);

    await registry.deliver({
      kind: 'follow.add',
      localOxyUserId: 'u1',
      localUsername: 'nate',
      targetActorUri: 'https://remote.example/users/bob',
    });

    expect(mocks.isFediverseSharingEnabled).toHaveBeenCalledWith('u1');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('calls the connector for follow.add when sharing is on for the local acting user', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(true);
    const deliver = vi.fn().mockResolvedValue(undefined);
    const registry = new ConnectorRegistry([makeConnector('activitypub', deliver)]);

    const event = {
      kind: 'follow.add' as const,
      localOxyUserId: 'u1',
      localUsername: 'nate',
      targetActorUri: 'https://remote.example/users/bob',
    };
    await registry.deliver(event);

    expect(deliver).toHaveBeenCalledWith(event);
  });

  it('does not call the connector for follow.remove when sharing is off for the local acting user', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);
    const deliver = vi.fn().mockResolvedValue(undefined);
    const registry = new ConnectorRegistry([makeConnector('activitypub', deliver)]);

    await registry.deliver({
      kind: 'follow.remove',
      localOxyUserId: 'u1',
      localUsername: 'nate',
      targetActorUri: 'https://remote.example/users/bob',
    });

    expect(mocks.isFediverseSharingEnabled).toHaveBeenCalledWith('u1');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('calls the connector for follow.remove when sharing is on for the local acting user', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(true);
    const deliver = vi.fn().mockResolvedValue(undefined);
    const registry = new ConnectorRegistry([makeConnector('activitypub', deliver)]);

    const event = {
      kind: 'follow.remove' as const,
      localOxyUserId: 'u1',
      localUsername: 'nate',
      targetActorUri: 'https://remote.example/users/bob',
    };
    await registry.deliver(event);

    expect(deliver).toHaveBeenCalledWith(event);
  });
});
