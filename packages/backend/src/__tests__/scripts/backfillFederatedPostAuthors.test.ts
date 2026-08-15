import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
  EXIT_INCOMPLETE,
  countRemaining,
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

/**
 * The run's VERDICT, which is what decides the exit code.
 *
 * Three production runs on 2026-08-15 repaired 520 of 578 orphans and all three
 * reported FAILURE, because `assertAdminRunComplete` was called with no
 * allowances and both of its triggers are structurally guaranteed: a dry run
 * resolves lookup-only, so unresolved authors are certain, and transient remote
 * failures are certain on any sweep over the open fediverse.
 *
 * The fix is not a tolerance FRACTION. This sweep has no cursor and a repaired
 * post leaves the orphan set, so run 2 scans exactly what run 1 could not repair
 * and its unresolved rate approaches 100% by construction — any fraction that
 * passes run 1 fails run 2, which is the same red-run-that-means-success in a
 * new dress. The residual is a separate exit path instead, and the completion
 * guard keeps only what a rate cannot excuse: our own side.
 */
describe('backfillFederatedPostAuthors — what counts as remaining', () => {
  /** A sweep that reached every bucket, so no assertion below is reading a zero. */
  const BUSY_RUN = {
    scanned: 578,
    linked: 520,
    gone: 3,
    deleteCandidates: 0,
    deleted: 0,
    blockedDelete: 2,
    unresolvedAuthor: 6,
    transient: 49,
    failed: 4,
  };

  it('is ZERO on a dry run, whatever the preview found', () => {
    // The default dispatch. A dry run writes nothing and resolves lookup-only,
    // so every unresolved orphan is an artefact of the mode and none of it is a
    // result to act on. Reporting a residual here is what made the DEFAULT
    // dispatch exit non-zero forever.
    expect(countRemaining(BUSY_RUN, { apply: false, deleteGone: false })).toBe(0);
    expect(countRemaining(BUSY_RUN, { apply: false, deleteGone: true })).toBe(0);
  });

  it('sums the three buckets a re-run can still repair', () => {
    // transient 49 + unresolvedAuthor 6 + gone 3.
    expect(countRemaining(BUSY_RUN, { apply: true, deleteGone: false })).toBe(58);
  });

  it('drops `gone` once the run was allowed to delete, since it became `deleted`', () => {
    expect(countRemaining(BUSY_RUN, { apply: true, deleteGone: true })).toBe(55);
  });

  it('never counts our OWN failures — they are the completion guard\'s, strictly', () => {
    /**
     * `failed` (a write that threw) and `blockedDelete` (a deletion the preflight
     * refused) are not fixed by re-running and must stay red. If either leaked
     * into the residual, a genuine write failure would exit 75 and the workflow
     * would report it GREEN. The `Pick` on the parameter type is what makes that
     * unreachable; this asserts the runtime agrees, since extra properties ride
     * along on a real `Counters` object.
     */
    const clean = { ...BUSY_RUN, failed: 0, blockedDelete: 0 };
    expect(countRemaining(clean, { apply: true, deleteGone: false })).toBe(
      countRemaining(BUSY_RUN, { apply: true, deleteGone: false }),
    );
  });

  it('is ZERO for a sweep that resolved everything — the positive control', () => {
    // Without this, "returns 0" above is also what a function that always
    // returns 0 does, and every assertion in this block would still pass.
    const spotless = { ...BUSY_RUN, gone: 0, unresolvedAuthor: 0, transient: 0 };
    expect(countRemaining(spotless, { apply: true, deleteGone: false })).toBe(0);
    expect(countRemaining(BUSY_RUN, { apply: true, deleteGone: false })).toBeGreaterThan(0);
  });
});

/**
 * What must still be a RED run, pinned in SOURCE.
 *
 * Making the residual non-fatal moved the risk: an unexpected exception folded
 * into `transient` would now exit 75 and the workflow would report it GREEN. The
 * two lines that keep that from happening are the page loop's catch-all and the
 * completion guard's argument list, and NEITHER has a functional symptom any
 * unit test can produce — reaching them means a real write failure, and mocking
 * the repository to raise one would be testing the mock. Same reasoning, and the
 * same shape, as `connectors/outboundPostPayloadShape.test.ts`.
 */
describe('backfillFederatedPostAuthors — what stays a red run', () => {
  const SOURCE = path.resolve(__dirname, '../../scripts/backfillFederatedPostAuthors.ts');

  /** The script's source with runs of whitespace collapsed, so formatting cannot decide a verdict. */
  function normalizedSource(): string {
    const source = readFileSync(SOURCE, 'utf8');
    // Vacuity floor: the right file, read, and big enough to hold what follows.
    expect(source).toContain('async function backfillFederatedPostAuthors(');
    expect(source.length).toBeGreaterThan(5000);
    return source.replace(/\s+/g, ' ');
  }

  it('sends a THROWN error to `failed`, never to the now-tolerated `transient`', () => {
    const source = normalizedSource();

    expect(source).toContain("? 'blockedDelete' as const : 'failed' as const");
    expect(source).not.toContain("? 'blockedDelete' as const : 'transient' as const");
  });

  it('hands the completion guard our OWN two buckets, and nothing a re-run fixes', () => {
    const source = normalizedSource();

    // Exact, so this pins the exclusion as well as the inclusion: putting
    // `transient` or `unresolvedAuthor` back would restore the always-red run.
    expect(source).toContain(
      "assertAdminRunComplete('backfillFederatedPostAuthors', { failed: counters.failed, "
      + 'blockedDelete: counters.blockedDelete, });',
    );
  });
});

describe('backfillFederatedPostAuthors — the exit code the workflow branches on', () => {
  const WORKFLOW = path.resolve(
    __dirname,
    '../../../../../.github/workflows/run-federated-author-backfill.yml',
  );

  it('is spelled identically in the script and in the workflow', () => {
    const workflow = readFileSync(WORKFLOW, 'utf8');

    // Vacuity floor: this is the right file, and it was read.
    expect(workflow).toContain('name: Run federated-author backfill');
    expect(workflow.length).toBeGreaterThan(1000);

    // The branch itself, anchored as a `case` arm so the constant's own prose
    // elsewhere in the file cannot satisfy it.
    expect(workflow).toMatch(new RegExp(`^\\s+${EXIT_INCOMPLETE}\\)$`, 'm'));
    expect(workflow).toContain('EXIT_INCOMPLETE in backfillFederatedPostAuthors.ts');
  });

  it('is neither success nor the generic failure code', () => {
    // A residual that exited 0 would be invisible; one that exited 1 is the bug
    // this replaced.
    expect(EXIT_INCOMPLETE).not.toBe(0);
    expect(EXIT_INCOMPLETE).not.toBe(1);
  });
});
