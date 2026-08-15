import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
} from '../helpers/federationFixtures';

const scope = federationScope('backfill-federated-post-authors');
const posts = postScope('backfill-federated-post-authors');

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearPostScope(posts);
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

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
vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  assertSafePublicUrl: vi.fn(),
}));

import {
  resolveAuthorOxyUserId,
  resolveOrphanAuthorUri,
} from '../../scripts/backfillFederatedPostAuthors';
import { extractActorUri, signedFetch, asRecord } from '../../connectors/activitypub/helpers';
import { assertSafePublicUrl } from '@oxyhq/core/server';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';

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

  it('keeps dry-run resolution lookup-only', async () => {
    const uri = `${scope.origin}/users/read-only`;
    await seedActor(scope, { username: 'read-only', uri, oxyUserId: 'oxy-existing' });

    await expect(resolveAuthorOxyUserId(uri, false)).resolves.toBe('oxy-existing');

    // Lookup-only: the row answered, and neither resolver was reached.
    expect(getOrFetchActor).not.toHaveBeenCalled();
    expect(fetchRemoteActor).not.toHaveBeenCalled();
  });
});

/**
 * The orphan cohort this script exists for carries NO stored `federation.actorUri`
 * — measured over all 578 rows on production, 2026-08-15. What 509 of them DO
 * carry is a Bridgy Fed object URL, and an AT-URI's authority is by protocol
 * definition the repo holding the record, i.e. the author. So the author is
 * knowable locally, and the script must take that route before the network one.
 *
 * These tests pin the ORDER of the three sources and, in the last case, the
 * correctness consequence: without the derivation a bridged post whose author
 * deleted it upstream answers 410 and becomes a deletion candidate, even though
 * its author was never in doubt.
 */
describe('backfillFederatedPostAuthors — resolveOrphanAuthorUri source order', () => {
  const DID = 'did:plc:b7kamuwqipovlbz2l5vhe2tb';
  const BRIDGY_OBJECT = `https://bsky.brid.gy/convert/ap/at://${DID}/app.bsky.feed.post/3mocp2h5ijs2n`;
  const BRIDGY_ACTOR = `https://bsky.brid.gy/ap/${DID}`;

  beforeEach(() => {
    vi.mocked(signedFetch).mockReset();
    vi.mocked(extractActorUri).mockReset();
    vi.mocked(asRecord).mockReset();
    vi.mocked(assertSafePublicUrl).mockReset();
  });

  it('derives the bridged author from the activity id with NO network call', async () => {
    const orphan = await seedPost(posts, {
      oxyUserId: null,
      authorship: [],
      federation: { activityId: BRIDGY_OBJECT, url: BRIDGY_OBJECT },
    });

    await expect(resolveOrphanAuthorUri(orphan)).resolves.toEqual({
      kind: 'ok',
      authorUri: BRIDGY_ACTOR,
      actorUriWasMissing: true,
    });

    // The whole point: the repair costs nothing at the network layer.
    expect(signedFetch).not.toHaveBeenCalled();
    expect(assertSafePublicUrl).not.toHaveBeenCalled();
  });

  it('still prefers a STORED actor uri over the derivation', async () => {
    const stored = 'https://mastodon.social/users/gargron';
    const orphan = await seedPost(posts, {
      oxyUserId: null,
      authorship: [],
      federation: { activityId: BRIDGY_OBJECT, url: BRIDGY_OBJECT, actorUri: stored },
    });

    await expect(resolveOrphanAuthorUri(orphan)).resolves.toEqual({
      kind: 'ok',
      authorUri: stored,
      actorUriWasMissing: false,
    });
    expect(signedFetch).not.toHaveBeenCalled();
  });

  /**
   * The negative control for the test above. A branch that answered every orphan
   * locally would pass "no network call" while quietly breaking the 69 posts that
   * genuinely need the fetch — so one ordinary Mastodon orphan must still reach it.
   */
  it('falls through to the network fetch for a NON-bridged orphan', async () => {
    const objectUrl = 'https://toot.community/users/someone/statuses/110';
    const authorUri = 'https://toot.community/users/someone';
    const orphan = await seedPost(posts, {
      oxyUserId: null,
      authorship: [],
      federation: { activityId: objectUrl, url: objectUrl },
    });

    vi.mocked(assertSafePublicUrl).mockResolvedValue({ ok: true });
    vi.mocked(signedFetch).mockResolvedValue(
      new Response(JSON.stringify({ attributedTo: authorUri }), { status: 200 }),
    );
    vi.mocked(asRecord).mockReturnValue({ attributedTo: authorUri });
    vi.mocked(extractActorUri).mockReturnValue(authorUri);

    await expect(resolveOrphanAuthorUri(orphan)).resolves.toEqual({
      kind: 'ok',
      authorUri,
      actorUriWasMissing: true,
    });
    expect(signedFetch).toHaveBeenCalledWith(objectUrl, expect.any(String));
  });

  it('repairs a bridged post whose upstream object is GONE, instead of marking it deletable', async () => {
    const orphan = await seedPost(posts, {
      oxyUserId: null,
      authorship: [],
      federation: { activityId: BRIDGY_OBJECT, url: BRIDGY_OBJECT },
    });

    // The author deleted the post on Bluesky: the object 410s, but the ACTOR is
    // unaffected. Before the derivation this fell into `gone` and, with
    // BACKFILL_DELETE_GONE, would have been deleted.
    vi.mocked(assertSafePublicUrl).mockResolvedValue({ ok: true });
    vi.mocked(signedFetch).mockResolvedValue(new Response(null, { status: 410 }));

    const result = await resolveOrphanAuthorUri(orphan);

    expect(result).toEqual({ kind: 'ok', authorUri: BRIDGY_ACTOR, actorUriWasMissing: true });
    expect(result.kind).not.toBe('gone');
  });
});
