/**
 * Oxy call budget for one `GET /search` request — the RECORDED BASELINE.
 *
 * Search is fired from a search box as the viewer types, and every Oxy call on
 * its path is a network round trip to another service. Nothing in this
 * repository pinned an Oxy call count for search, so nobody could say whether a
 * change to the path added one. This file is that number, written down before
 * the search overhaul changes it, so every later claim about search's Oxy cost
 * is a diff against a measurement rather than an assertion.
 *
 * ## What the numbers here are, and what they are not
 *
 * Four graph reads per request, each exactly once. They are NOT waste:
 * `buildViewerContext` needs the viewer's blocked, restricted, following and
 * follower sets to filter results correctly, and it resolves each one time.
 *
 * The duplication is ACROSS requests, not within one. The search screen's "All"
 * tab issues `/search` and `/posts/saved` as separate HTTP requests, and each
 * pays these four for the same answers — which no amount of threading inside
 * one handler can fix. Only one combined server-side endpoint, resolving the
 * viewer context once and handing it to every lane, collapses that; when it
 * lands, the per-request numbers below should stay the same while the
 * per-SEARCH total halves.
 *
 * Threading `viewerGraph`/`viewerPrivacy` into search's hydration was tried
 * first and reverted, because measuring it here showed the counts IDENTICAL
 * before and after: hydration already resolved each one once, so moving the
 * resolution into the handler moved it without removing it. That is the reason
 * this file exists at all rather than the change it was written to justify.
 *
 * A related finding worth knowing before touching `searchPosts.test.ts`: its
 * case named "does not pay for the follow-graph lookup when no rule needs it"
 * mocks `PostHydrationService` wholesale, so it cannot see hydration's own
 * follow-graph reads. It pins that the MUTE-WORD path adds no second call — a
 * narrower guarantee than the name suggests, and search has always paid for the
 * graph on every request regardless.
 *
 * ## Why a spy on the client, and not the metrics registry
 *
 * Same reason `feedEngineViewerGraphBudget.test.ts` gives: `oxy_calls_total` is
 * recorded from a patch on `HttpService`'s prototype, reached only through a
 * real `OxyServices` making a real request, so under a mocked client it records
 * nothing and a budget read from it would pass at zero whatever the route did.
 * The spy is sound because every Oxy read on this path goes through the one
 * client object `createScopedOxyClient` hands back, and this test owns it.
 *
 * Counts are asserted as EQUALITIES so a failure reports how many calls leaked
 * rather than just that some did.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { eq } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { muteWords } from '../../db/schema/engagement';
import { clearFederationScope, federationScope, seedPost } from '../helpers/federationFixtures';

const scope = federationScope('search-oxy-call-budget');

/** Every Oxy read the search path can make, counted per call. */
const calls = {
  // Bare arrays, not `{ data: [] }`: `readPrivacyList` maps over the return
  // value directly, and a wrapped shape throws — which the fail-closed contract
  // turns into a 500 rather than an empty list, so the mock's shape is itself
  // load-bearing here.
  getUserFollowing: vi.fn(async () => []),
  getUserFollowers: vi.fn(async () => []),
  getBlockedUsers: vi.fn(async () => []),
  getRestrictedUsers: vi.fn(async () => []),
  getUsersByIds: vi.fn(async (ids: string[]) =>
    ids.map((id) => ({ id, username: `u${id.slice(-6)}`, name: {}, languages: ['en-US'] })),
  ),
  getClarityDocuments: vi.fn(async () => []),
};

vi.mock('../../utils/oxyHelpers', () => ({
  // BOTH factories hand back the same object, so a call made through either
  // seam lands in the same counters — otherwise a leak could hide behind the
  // service client while the scoped one looked clean.
  createScopedOxyClient: () => calls,
  getServiceOxyClient: () => calls,
  getRuntimeOxyClient: () => calls,
  createUserScopedOxyServices: () => calls,
}));

const VIEWER = 'search-budget-viewer';

let app: express.Express;

beforeAll(async () => {
  await connectPostgres();
  const searchRoutes = (await import('../../routes/search')).default;
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: string } }).user = { id: VIEWER };
    next();
  });
  app.use('/search', searchRoutes);
});

afterAll(async () => {
  await clearFederationScope(scope);
  await closePostgres();
});

beforeEach(() => {
  for (const spy of Object.values(calls)) spy.mockClear();
});

describe('GET /search Oxy call budget', () => {
  it('resolves each viewer-graph read exactly ONCE per request', async () => {
    await seedPost(scope, {
      oxyUserId: scope.user('author'),
      content: { variants: [{ source: 'author', tag: 'en', text: 'a budget probe about gardening' }] },
    });

    await request(app).get('/search').query({ query: 'gardening', type: 'posts' }).expect(200);

    // The four the viewer's safety and graph context needs. Each must be ONE:
    // more than one means a second resolver ran on the same request. Today
    // `buildViewerContext` is the only one, and this is what pins that.
    expect(calls.getUserFollowing).toHaveBeenCalledTimes(1);
    expect(calls.getUserFollowers).toHaveBeenCalledTimes(1);
    expect(calls.getBlockedUsers).toHaveBeenCalledTimes(1);
    expect(calls.getRestrictedUsers).toHaveBeenCalledTimes(1);
  });

  it('asks for the following list TWICE when an exclude-following mute rule exists', async () => {
    // A recorded inefficiency, not an endorsement.
    //
    // An `exclude-following` muted word needs to know who the viewer follows,
    // so `loadFollowedAuthorIds` asks Oxy for the following list — on a request
    // where `buildViewerContext` has already resolved exactly that. Two reads,
    // one answer. It is uncommon (most viewers have no such rule) and it is
    // pure waste when it happens.
    //
    // Pinned at 2 rather than "fixed" here because the fix requires the handler
    // to own the viewer-context resolution so it can hand the list in, and that
    // is the combined-endpoint change. When that lands, this expectation
    // becomes 1 — and this test is what will require someone to notice.
    await getDb().insert(muteWords).values({
      userId: VIEWER,
      value: 'gardening',
      targets: ['content'],
      actorTarget: 'exclude-following',
    });

    try {
      await seedPost(scope, {
        oxyUserId: scope.user('author2'),
        content: { variants: [{ source: 'author', tag: 'en', text: 'another budget probe about gardening' }] },
      });

      await request(app).get('/search').query({ query: 'gardening', type: 'posts' }).expect(200);

      expect(calls.getUserFollowing).toHaveBeenCalledTimes(2);
    } finally {
      await getDb().delete(muteWords).where(eq(muteWords.userId, VIEWER));
    }
  });

  it('resolves the viewer profile once, for their account languages', async () => {
    // `buildLanguageCandidates` resolves the VIEWER's own summary to read their
    // account languages, which is real data no request header carries — so
    // this call is legitimate, and threading `requestLanguages` would not
    // remove it (that is driven by the separate `viewerLanguages` option). It
    // is pinned so a SECOND resolution of the same summary would show up.
    //
    // Recorded because it was initially mistaken for waste.
    await seedPost(scope, {
      oxyUserId: scope.user('author3'),
      content: {
        variants: [
          { source: 'author', tag: 'en', text: 'a budget probe about llamas' },
          { source: 'author', tag: 'es', text: 'una prueba sobre llamas' },
        ],
      },
    });

    await request(app)
      .get('/search')
      .set('Accept-Language', 'es-ES')
      .query({ query: 'llamas', type: 'posts' })
      .expect(200);

    const viewerResolutions = calls.getUsersByIds.mock.calls
      .flatMap(([ids]) => ids)
      .filter((id) => id === VIEWER);
    expect(viewerResolutions).toHaveLength(1);
  });

  it('asks Oxy nothing at all for an anonymous viewer', async () => {
    const anonymous = express();
    anonymous.use(express.json());
    anonymous.use('/search', (await import('../../routes/search')).default);

    await request(anonymous).get('/search').query({ query: 'gardening', type: 'posts' }).expect(200);

    expect(calls.getUserFollowing).toHaveBeenCalledTimes(0);
    expect(calls.getUserFollowers).toHaveBeenCalledTimes(0);
    expect(calls.getBlockedUsers).toHaveBeenCalledTimes(0);
    expect(calls.getRestrictedUsers).toHaveBeenCalledTimes(0);
  });
});
