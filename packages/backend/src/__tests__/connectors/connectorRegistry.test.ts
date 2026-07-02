import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ConnectorRegistry fan-out isolation: `federateNewPost` must attempt delivery to
 * EVERY enabled connector even when one throws (best-effort outbound federation),
 * resolve once all are attempted, and log each rejection with the connector id.
 */

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    error: mocks.loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// This file exercises the fan-out/isolation behavior of `federateNewPost`, not
// the fediverseSharing gate (covered by `connectorRegistrySharingGate.test.ts`)
// — default every acting user to "sharing on" so the gate never short-circuits
// delivery here.
vi.mock('../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: (...args: unknown[]) => mocks.isFediverseSharingEnabled(...args),
}));

import { ConnectorRegistry } from '../../connectors/ConnectorRegistry';
import type {
  NetworkConnector,
  NetworkId,
  LocalPostEventPayload,
} from '../../connectors/types';

/** A minimal fake connector with overridable, spy-able `deliver`. */
function makeConnector(
  id: NetworkId,
  deliver: NetworkConnector['deliver'],
  enabled = true,
): NetworkConnector {
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

const POST: LocalPostEventPayload = {
  _id: 'p1',
  content: { text: 'hello' },
  visibility: 'public',
  createdAt: '2024-01-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isFediverseSharingEnabled.mockResolvedValue(true);
});

describe('ConnectorRegistry.federateNewPost', () => {
  it('still delivers to the other connectors when one connector rejects, and resolves', async () => {
    const okDeliver = vi.fn().mockResolvedValue(undefined);
    const failDeliver = vi.fn().mockRejectedValue(new Error('transient AP network error'));
    const otherOkDeliver = vi.fn().mockResolvedValue(undefined);

    const registry = new ConnectorRegistry([
      makeConnector('activitypub', failDeliver),
      makeConnector('atproto', okDeliver),
      // A second healthy connector after the failing one proves the fan-out is
      // not short-circuited by the earlier rejection (Promise.allSettled).
      makeConnector('atproto', otherOkDeliver),
    ]);

    await expect(
      registry.federateNewPost(POST, 'oxy-1', 'alice'),
    ).resolves.toBeUndefined();

    expect(failDeliver).toHaveBeenCalledTimes(1);
    expect(okDeliver).toHaveBeenCalledTimes(1);
    expect(otherOkDeliver).toHaveBeenCalledTimes(1);
    for (const deliver of [failDeliver, okDeliver, otherOkDeliver]) {
      expect(deliver).toHaveBeenCalledWith({
        kind: 'post.create',
        post: POST,
        actorOxyUserId: 'oxy-1',
        actorUsername: 'alice',
      });
    }
  });

  it('logs each rejected connector with its id, not silently swallowing', async () => {
    const reason = new Error('boom');
    const registry = new ConnectorRegistry([
      makeConnector('activitypub', vi.fn().mockRejectedValue(reason)),
      makeConnector('atproto', vi.fn().mockResolvedValue(undefined)),
    ]);

    await registry.federateNewPost(POST, 'oxy-1', 'alice');

    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining('"activitypub"'),
      reason,
    );
  });

  it('skips disabled connectors entirely', async () => {
    const enabledDeliver = vi.fn().mockResolvedValue(undefined);
    const disabledDeliver = vi.fn().mockResolvedValue(undefined);

    const registry = new ConnectorRegistry([
      makeConnector('activitypub', enabledDeliver, true),
      makeConnector('atproto', disabledDeliver, false),
    ]);

    await registry.federateNewPost(POST, 'oxy-1', 'alice');

    expect(enabledDeliver).toHaveBeenCalledTimes(1);
    expect(disabledDeliver).not.toHaveBeenCalled();
  });
});
