/**
 * `alsoKnownAs` publication: a local account whose aliases changed in Oxy is
 * rebroadcast as an `actor.update` promptly, because Mastodon refuses a Move to
 * an account that does not already list the old one.
 *
 * Redis is an in-memory double that honours the two options the check relies on
 * — `NX` (one task per event) and `GET` (atomic swap of the announced set) — so
 * the dedupe is exercised, not assumed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  isReady: true,
  hasActorKeyPair: vi.fn(),
  getUserById: vi.fn(),
  getProfileByUsername: vi.fn(),
  federate: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../utils/redis', () => ({
  getRedisClient: () => ({
    get isReady() {
      return mocks.isReady;
    },
    set: async (key: string, value: string, options: { NX?: boolean; GET?: boolean } = {}) => {
      const previous = mocks.store.get(key) ?? null;
      if (options.NX && previous !== null) return null;
      mocks.store.set(key, value);
      return options.GET ? previous : 'OK';
    },
    del: async (key: string) => (mocks.store.delete(key) ? 1 : 0),
  }),
}));

vi.mock('../../../db/federation/actorKeyPairRepository', () => ({ hasActorKeyPair: mocks.hasActorKeyPair }));
vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUserById: mocks.getUserById, getProfileByUsername: mocks.getProfileByUsername }),
}));
vi.mock('../../../connectors/outboundFederation', () => ({ federateAsResolvedActorAndWait: mocks.federate }));
vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

import { aliasFingerprint, publishAliasChange } from '../../../services/federation/aliasPublication';

const OLD = 'https://mastodon.example/users/alice';

function aliases(values: string[] | undefined) {
  mocks.getProfileByUsername.mockResolvedValue({ id: 'u1', username: 'alice', ...(values ? { alsoKnownAs: values } : {}) });
}

let at = 0;
const event = () => ({ userId: 'u1', at: ++at });

describe('publishAliasChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    mocks.isReady = true;
    mocks.hasActorKeyPair.mockResolvedValue(true);
    mocks.getUserById.mockResolvedValue({ id: 'u1', username: 'alice' });
    mocks.federate.mockResolvedValue(undefined);
  });

  it('sends the actor Update when an alias appears, through the existing actor.update event', async () => {
    aliases([OLD]);
    await expect(publishAliasChange(event())).resolves.toBe('published');

    expect(mocks.federate).toHaveBeenCalledTimes(1);
    const [userId, , build] = mocks.federate.mock.calls[0];
    expect(userId).toBe('u1');
    expect(build('alice')).toEqual({ kind: 'actor.update', actorOxyUserId: 'u1', actorUsername: 'alice' });
  });

  it('stays quiet for a profile edit that leaves the aliases as they were', async () => {
    aliases([OLD]);
    await publishAliasChange(event());
    mocks.federate.mockClear();

    await expect(publishAliasChange(event())).resolves.toBe('unchanged');
    expect(mocks.federate).not.toHaveBeenCalled();
  });

  it('announces a removal too', async () => {
    aliases([OLD]);
    await publishAliasChange(event());
    mocks.federate.mockClear();
    aliases([]);

    await expect(publishAliasChange(event())).resolves.toBe('published');
    expect(mocks.federate).toHaveBeenCalledTimes(1);
  });

  it('does not announce an account that never had an alias', async () => {
    aliases(undefined);
    await expect(publishAliasChange(event())).resolves.toBe('unchanged');
    expect(mocks.federate).not.toHaveBeenCalled();
  });

  it('lets exactly one task handle an event every task receives', async () => {
    aliases([OLD]);
    const shared = event();
    const outcomes = await Promise.all([publishAliasChange(shared), publishAliasChange(shared), publishAliasChange(shared)]);

    expect(outcomes.filter((o) => o === 'published')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'claimed_elsewhere')).toHaveLength(2);
    expect(mocks.federate).toHaveBeenCalledTimes(1);
  });

  it('skips a federated mirror (no key pair) without reading Oxy', async () => {
    mocks.hasActorKeyPair.mockResolvedValue(false);
    await expect(publishAliasChange(event())).resolves.toBe('not_local');
    expect(mocks.getUserById).not.toHaveBeenCalled();
  });

  it('is inert without Redis', async () => {
    mocks.isReady = false;
    await expect(publishAliasChange(event())).resolves.toBe('no_redis');
    expect(mocks.federate).not.toHaveBeenCalled();
  });

  it('restores the announced set when delivery fails, so the next event retries', async () => {
    aliases([OLD]);
    mocks.federate.mockRejectedValueOnce(new Error('delivery failed'));
    await expect(publishAliasChange(event())).resolves.toBe('failed');
    expect(mocks.warn).toHaveBeenCalled();

    await expect(publishAliasChange(event())).resolves.toBe('published');
  });
});

describe('aliasFingerprint', () => {
  it('compares as a set of publishable https URIs', () => {
    expect(aliasFingerprint([OLD, 'https://b.example/u'])).toBe(aliasFingerprint(['https://b.example/u', OLD, OLD]));
    expect(aliasFingerprint(['http://insecure.example/u', 'not a url'])).toBe(aliasFingerprint([]));
  });
});
