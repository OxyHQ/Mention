import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The reported bug, end to end: an ANONYMOUS For You request, through the real
 * controller, the real engine and a real database.
 *
 * ## What went wrong
 *
 * Measured against production on 2026-09-05, an anonymous
 * `GET /feed/mtn?descriptor=for_you&limit=50` came back **48% German** — from a
 * corpus that is **6.8% German** (censused over 400 posts paged from Discover).
 * A 7x over-selection, and none of it corpus-driven: German Mastodon accounts
 * carry high engagement, and engagement was the only axis anything sorted on.
 *
 * Three separate things had to be true at once for a reader's languages to reach
 * nothing, which is why no single unit test could have caught it:
 *
 *   1. `loadViewerLanguages` returned `[]` for every signed-out reader, so
 *      `ctx.viewerLanguages` was empty and every language-conditional path
 *      downstream went neutral by its own fail-soft contract;
 *   2. `popularSource` — which IS the whole For You feed when there is no
 *      `currentUserId` — carried no language predicate, and bypasses
 *      `FeedEngine.gatherPool` entirely, so it inherited neither the discovery
 *      gate nor the `_discovery` mark `languageMismatchPenalty` keys off; and
 *   3. the one filter that did exist, the `filterByLanguage` tuner, was never
 *      fed by its only caller and so had never run.
 *
 * ## Why this test is end-to-end rather than a unit test
 *
 * Each of those three layers was individually defensible and had passing tests.
 * What was broken was the PATH between them: a header that never became a
 * predicate. A test that stubs any one layer cannot observe that, so this one
 * stubs none of the path — it sends a request with an `Accept-Language` header
 * and asserts on the rows that come back.
 *
 * The German fixture deliberately carries MORE engagement than the Spanish one.
 * That is not decoration: it is the ordering that produced the bug, so a
 * regression does not merely reorder the page, it puts the German post back on
 * top of it.
 */

import { PostVisibility } from '@mention/shared-types';

// Hydration is stubbed to the identity: it resolves Oxy accounts over the
// network, which has nothing to do with which candidates the query returned, and
// leaving it real would make this suite fail for reasons that are not about
// language. Everything BETWEEN the header and the rows stays real.
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: unknown[]) => slices),
    hydratePosts: vi.fn(async (records: unknown[]) => records),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { registerAllModules } from '../../mtn/feed/engine';
import { mtnFeedController } from '../../mtn/controllers/feed.controller';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { eq } from 'drizzle-orm';

const scope = serviceScope('for-you-language-e2e');

interface Res {
  statusCode: number;
  body: unknown;
  status(code: number): Res;
  json(payload: unknown): Res;
}

function makeRes(): Res {
  const res: Res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

/** An ANONYMOUS request, optionally declaring languages the way a browser does. */
function anonRequest(acceptLanguage?: string[]): unknown {
  return {
    query: { descriptor: 'for_you', limit: '50' },
    user: undefined,
    acceptsLanguages: () => acceptLanguage ?? [],
  };
}

/** Seed a public root with a resolved classification language and engagement. */
async function seedInLanguage(languages: string[] | undefined, likes: number): Promise<string> {
  const record = await seedPost(scope, {
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    ...(languages ? { language: languages[0], postClassification: { status: 'baseline', topics: [], languages } } : {}),
  });
  await getDb().update(posts).set({ statsLikesCount: likes }).where(eq(posts.id, record.id));
  return record.id;
}

/** The ids THIS suite seeded, in the order the feed returned them. */
async function feedIds(request: unknown, mine: string[]): Promise<string[]> {
  const res = makeRes();
  await mtnFeedController.getFeed(request as never, res as never);
  expect(res.statusCode).toBe(200);
  const body = res.body as { success: boolean; data?: { items?: Array<{ id: string }> } };
  expect(body.success).toBe(true);
  return (body.data?.items ?? []).map((item) => item.id).filter((id) => mine.includes(id));
}

beforeAll(async () => {
  await connectPostgres();
  // The engine resolves sources from the shared registry, which the server
  // populates at bootstrap. Without this the definition's sources resolve to
  // nothing and every feed comes back empty — which would make the language
  // assertions below pass for entirely the wrong reason.
  registerAllModules();
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('anonymous For You — the reader language reaches the query', () => {
  it('excludes an off-language post for a reader whose browser declared es', async () => {
    const spanish = await seedInLanguage(['es'], 10);
    const german = await seedInLanguage(['de'], 5_000);
    const mine = [spanish, german];

    expect(await feedIds(anonRequest(['es-ES', 'es', 'en']), mine)).toEqual([spanish]);
  });

  /**
   * THE POSITIVE CONTROL, and this suite is worthless without it.
   *
   * "The German post is absent" is satisfied by a feed that returned nothing at
   * all — an empty database, a recency window that excluded the fixtures, a 500
   * swallowed into an empty page. The SAME two rows and the SAME request minus
   * the header must return BOTH, German first on engagement. That ordering is
   * also the bug itself, reproduced: it is what every signed-out reader saw.
   */
  it('returns BOTH — German first — for a reader who declared nothing', async () => {
    const spanish = await seedInLanguage(['es'], 10);
    const german = await seedInLanguage(['de'], 5_000);
    const mine = [spanish, german];

    expect(await feedIds(anonRequest(), mine)).toEqual([german, spanish]);
  });

  /**
   * `?lang` ADDS to what the reader can read; it does not replace the header.
   *
   * That is `requestLanguageCandidates`' existing contract — it builds an ordered
   * candidate LADDER (`?lang` first, then `Accept-Language`) because its other
   * consumer, variant resolution, walks it in order looking for the best
   * rendition. Readability consumes the same ladder as a SET, so a reader who
   * asks for German while their browser says Spanish can read both. Widening the
   * set is the safe direction for a filter; narrowing it on a query parameter
   * would let a stray `?lang` empty somebody's feed.
   */
  it('ADDS an explicit ?lang to the header languages rather than replacing them', async () => {
    const spanish = await seedInLanguage(['es'], 10);
    const german = await seedInLanguage(['de'], 5_000);
    const french = await seedInLanguage(['fr'], 9_000);
    const mine = [spanish, german, french];

    const request = {
      query: { descriptor: 'for_you', limit: '50', lang: 'de' },
      user: undefined,
      acceptsLanguages: () => ['es-ES'],
    };
    // German and Spanish are both readable; French — declared by neither — is not,
    // which is what keeps this from being satisfied by a filter that does nothing.
    expect(await feedIds(request, mine)).toEqual([german, spanish]);
  });

  /**
   * Discover is the deliberate exemption: it is the open window on the whole
   * network, so the same reader, the same rows and the same header must still
   * see everything there. This is what proves the filter is scoped to For You
   * rather than applied globally — the assertion the production A/B repeats.
   */
  it('does NOT filter Discover for the same reader', async () => {
    const spanish = await seedInLanguage(['es'], 10);
    const german = await seedInLanguage(['de'], 5_000);
    const mine = [spanish, german];

    const request = {
      query: { descriptor: 'explore', limit: '50' },
      user: undefined,
      acceptsLanguages: () => ['es-ES', 'es'],
    };
    const res = makeRes();
    await mtnFeedController.getFeed(request as never, res as never);
    const body = res.body as { data?: { slices?: Array<{ items: Array<{ post: { id: string } }> }>; items?: Array<{ id: string }> } };
    // A ranked feed reports the SAME posts in both shapes — `slices` for the
    // thread-grouped client, `items` flattened — so the two are unioned, not
    // concatenated.
    const returned = new Set(
      [
        ...(body.data?.items ?? []).map((item) => item.id),
        ...(body.data?.slices ?? []).flatMap((slice) => slice.items.map((item) => item.post.id)),
      ].filter((id) => mine.includes(id)),
    );

    expect([...returned].sort()).toEqual([...mine].sort());
  });
});
