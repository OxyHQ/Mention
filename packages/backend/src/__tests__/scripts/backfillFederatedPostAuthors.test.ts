import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Concurrency test for the federated-post author backfill's actor resolution.
 *
 * The dry run showed HTTP 409 "conflict" races on `/users/resolve`: within a
 * page-chunk, multiple orphans of the SAME actor concurrently trigger federated
 * Oxy-user creation. `resolveAuthorOxyUserId` memoizes the IN-FLIGHT promise per
 * actor URI so concurrent callers for one actor await a SINGLE underlying resolve
 * (`actorService.getOrFetchActor`), and the settled value is then cached for the
 * rest of the run. These offline tests mock the actor service (and the script's
 * other module imports) so ONLY the dedup logic runs — no DB, no network.
 */

const { getOrFetchActor, fetchRemoteActor } = vi.hoisted(() => ({
  getOrFetchActor: vi.fn(),
  fetchRemoteActor: vi.fn(),
}));

vi.mock('../../connectors/activitypub/actor.service', () => ({
  actorService: { getOrFetchActor, fetchRemoteActor },
}));

// The script imports these at module load; stub them so importing it stays
// hermetic (none are exercised by `resolveAuthorOxyUserId`).
vi.mock('../../connectors/activitypub/helpers', () => ({
  extractActorUri: vi.fn(),
  signedFetch: vi.fn(),
  asRecord: vi.fn(),
}));
vi.mock('../../connectors/activitypub/constants', () => ({ AP_CONTENT_TYPE: 'application/activity+json' }));
vi.mock('../../models/Post', () => ({ Post: {} }));
vi.mock('../../utils/ssrfGuard', () => ({ assertSafePublicUrl: vi.fn() }));

import { resolveAuthorOxyUserId } from '../../scripts/backfillFederatedPostAuthors';

/** A promise plus its externally-callable resolver, for holding a resolve in-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('backfillFederatedPostAuthors — resolveAuthorOxyUserId in-flight dedup', () => {
  beforeEach(() => {
    getOrFetchActor.mockReset();
    fetchRemoteActor.mockReset();
  });

  it('collapses two CONCURRENT resolves of the same actor onto ONE getOrFetchActor', async () => {
    const uri = 'https://mastodon.online/users/kaleidotrope';
    const gate = deferred<{ oxyUserId: string }>();
    // Hold the resolve in-flight so both callers are pending simultaneously.
    getOrFetchActor.mockReturnValueOnce(gate.promise);

    const first = resolveAuthorOxyUserId(uri);
    const second = resolveAuthorOxyUserId(uri);

    // Both callers are now awaiting the SAME in-flight resolution.
    gate.resolve({ oxyUserId: 'oxy-kaleidotrope' });
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe('oxy-kaleidotrope');
    expect(b).toBe('oxy-kaleidotrope');
    // The whole point: the underlying resolve ran exactly once.
    expect(getOrFetchActor).toHaveBeenCalledTimes(1);
    expect(fetchRemoteActor).not.toHaveBeenCalled();
  });

  it('serves a settled actor from the cache without re-resolving', async () => {
    const uri = 'https://mastodon.social/users/gargron';
    getOrFetchActor.mockResolvedValueOnce({ oxyUserId: 'oxy-gargron' });

    const firstPass = await resolveAuthorOxyUserId(uri);
    const secondPass = await resolveAuthorOxyUserId(uri);

    expect(firstPass).toBe('oxy-gargron');
    expect(secondPass).toBe('oxy-gargron');
    // The second (sequential) call is served from actorOxyCache.
    expect(getOrFetchActor).toHaveBeenCalledTimes(1);
  });
});
