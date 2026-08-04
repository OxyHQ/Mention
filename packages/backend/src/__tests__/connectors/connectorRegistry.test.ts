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

import type { PostContent } from '@mention/shared-types';
import type {
  NetworkConnector,
  NetworkId,
  LocalNetworkEvent,
  LocalPostEventPayload,
} from '@oxyhq/federation';
import type { FederatablePost } from '../../services/serviceRegistry';
import { ConnectorRegistry } from '../../connectors/ConnectorRegistry';

/** A minimal fake connector with overridable, spy-able `deliver`. */
function makeConnector(
  id: NetworkId,
  deliver: NetworkConnector<PostContent>['deliver'],
  enabled = true,
): NetworkConnector<PostContent> {
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

/**
 * What `PostCreationService` hands the registry: a `FederatablePost`, keyed on
 * `id`. The registry translates it to the SDK's `LocalPostEventPayload`, which
 * still says `_id` — see {@link FederatablePost}. That translation is asserted
 * rather than assumed below, because it is the one place the two id spellings
 * meet and a silent `undefined` there federates a Note with no object id.
 */
const POST: FederatablePost = {
  id: 'p1',
  content: { text: 'hello' },
  visibility: 'public',
  createdAt: '2024-01-01T00:00:00.000Z',
};

/** The same post as the SDK sees it, after the registry's id translation. */
const DELIVERED_POST = { ...POST, _id: 'p1' };

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
        post: DELIVERED_POST,
        actorOxyUserId: 'oxy-1',
        actorUsername: 'alice',
      });
    }
  });

  it('logs a rejected connector with bounded operational dimensions', async () => {
    const reason = new Error('boom');
    const registry = new ConnectorRegistry([
      makeConnector('activitypub', vi.fn().mockRejectedValue(reason)),
      makeConnector('atproto', vi.fn().mockResolvedValue(undefined)),
    ]);

    await registry.federateNewPost(POST, 'oxy-1', 'alice');

    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      '[connectors] delivery failed',
      {
        connector: 'activitypub',
        error: reason,
        type: 'post.create',
      },
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

describe('ConnectorRegistry durable delivery', () => {
  const LIKE_EVENT: LocalNetworkEvent<PostContent> = {
    kind: 'post.like',
    like: { _id: 'like-1', postId: 'post-1' },
    actorOxyUserId: 'oxy-1',
    actorUsername: 'alice',
  };

  it('selects the durable connector boundary only for strict delivery', async () => {
    const bestEffort = vi.fn().mockResolvedValue(undefined);
    const durable = vi.fn().mockResolvedValue(undefined);
    const connector = Object.assign(
      makeConnector('activitypub', bestEffort),
      { deliverDurably: durable },
    );
    const registry = new ConnectorRegistry([connector]);

    await registry.deliver(LIKE_EVENT);
    await registry.deliverStrict(LIKE_EVENT);

    expect(bestEffort).toHaveBeenCalledTimes(1);
    expect(durable).toHaveBeenCalledTimes(1);
    expect(durable).toHaveBeenCalledWith(LIKE_EVENT);
  });

  it('surfaces a durable connector rejection to the outbox caller', async () => {
    const reason = new Error('delivery queue unavailable');
    const connector = Object.assign(
      makeConnector('activitypub', vi.fn().mockResolvedValue(undefined)),
      { deliverDurably: vi.fn().mockRejectedValue(reason) },
    );
    const registry = new ConnectorRegistry([connector]);

    await expect(registry.deliverStrict(LIKE_EVENT)).rejects.toThrow(
      'Connector delivery failed for post.like',
    );
  });
});

/**
 * The extra-audience capability, declared locally the same way `deliverDurably`
 * is: a connector that cannot widen an audience simply does not implement the
 * method, and the registry falls through to plain `deliver` rather than anything
 * in `@oxyhq/federation` having to grow a field for one app's addressing need.
 *
 * Each case is asserted against a connector that implements BOTH methods, so a
 * dispatch that picked the wrong one would call the wrong spy rather than
 * quietly doing the same thing.
 */
describe('ConnectorRegistry extra audiences', () => {
  function makeAudienceConnector() {
    const plain = vi.fn().mockResolvedValue(undefined);
    const widened = vi.fn().mockResolvedValue(undefined);
    const connector = Object.assign(makeConnector('activitypub', plain), {
      deliverToExtraAudiences: widened,
    });
    return { connector, plain, widened };
  }

  it('routes to the widened path only when audiences were named', async () => {
    const { connector, plain, widened } = makeAudienceConnector();
    const registry = new ConnectorRegistry([connector]);

    await registry.federateNewPost(POST, 'oxy-1', 'alice', ['oxy-2']);

    expect(widened).toHaveBeenCalledTimes(1);
    // `DELIVERED_POST`, not `POST` — the widened path carries the SAME
    // app→SDK id translation the ordinary one does. Asserting the untranslated
    // shape here would let the two paths drift on the one field that decides
    // whether the Note gets an object id at all.
    expect(widened).toHaveBeenCalledWith(
      { kind: 'post.create', post: DELIVERED_POST, actorOxyUserId: 'oxy-1', actorUsername: 'alice' },
      ['oxy-2'],
    );
    expect(plain).not.toHaveBeenCalled();
  });

  it('takes the ordinary path when no audience was named', async () => {
    const { connector, plain, widened } = makeAudienceConnector();
    const registry = new ConnectorRegistry([connector]);

    await registry.federateNewPost(POST, 'oxy-1', 'alice');

    expect(plain).toHaveBeenCalledTimes(1);
    expect(widened).not.toHaveBeenCalled();
  });

  it('takes the ordinary path for an EMPTY audience list', async () => {
    // A single-voice thread passes `[]` on every entry, which must cost nothing.
    const { connector, plain, widened } = makeAudienceConnector();
    const registry = new ConnectorRegistry([connector]);

    await registry.federateNewPost(POST, 'oxy-1', 'alice', []);

    expect(plain).toHaveBeenCalledTimes(1);
    expect(widened).not.toHaveBeenCalled();
  });

  it('falls back to plain delivery for a connector without the capability', async () => {
    const plain = vi.fn().mockResolvedValue(undefined);
    const registry = new ConnectorRegistry([makeConnector('atproto', plain)]);

    await registry.federateNewPost(POST, 'oxy-1', 'alice', ['oxy-2']);

    expect(plain).toHaveBeenCalledTimes(1);
  });

  it('still refuses when the acting account does not share, audiences or not', async () => {
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);
    const { connector, plain, widened } = makeAudienceConnector();
    const registry = new ConnectorRegistry([connector]);

    await registry.federateNewPost(POST, 'oxy-1', 'alice', ['oxy-2']);

    expect(plain).not.toHaveBeenCalled();
    expect(widened).not.toHaveBeenCalled();
  });
});
