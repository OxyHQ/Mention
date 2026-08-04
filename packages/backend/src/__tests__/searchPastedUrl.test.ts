/**
 * `GET /search` — a pasted URL, a handle typed alone, and a query that runs out
 * of time. Against REAL rows.
 *
 * ## The two production failures this file was written for
 *
 * A pasted URL was handed straight to Mongo's `$text`, which TOKENISES it — so
 * `https://x.com/thinkymachines` became roughly `https OR x.com OR
 * thinkymachines`, and `https` alone matched a large share of every post ever
 * written. Sorted by `createdAt` rather than text score, Mongo had to collect
 * every match before ordering, blew through `maxTimeMS` (observed at
 * 3017/3036/3119/3078 ms against a 3000 ms cap) and threw — reaching the client
 * as a 500, which reads as "the server is broken". A handle typed alone
 * (`@betomoedano@x.com` → roughly `betomoedano OR x OR com`) failed identically.
 *
 * ## Why the old assertions could not survive the port, and what replaced them
 *
 * They mocked `models/Post` and asserted `find` was NOT CALLED. Nothing calls
 * that model; search reads `post_content_variants.search_vector` through
 * drizzle. Worse, "no query was issued" stopped being the interesting property:
 * Postgres does not have Mongo's failure mode at all
 * (`websearch_to_tsquery('https://x.com/…')` is `'https' & '/x.com/…'` — an AND,
 * and a document carrying a URL has no bare `https` lexeme), so the branch's job
 * here is to make the empty answer **INTENTIONAL rather than incidental**.
 *
 * That is exactly what a fixture can be built to distinguish. Every
 * short-circuit case below seeds a post the query WOULD match — measured against
 * this database's own `english` configuration, and re-measured in-suite by the
 * vacuity floor — so removing the branch does not merely change a call count, it
 * changes the RESULT SET. `nate@oxy.so` and `@alice what did you think` are the
 * controls in the other direction: an email is not a handle and a sentence
 * mentioning somebody is still a search, and each returns its post.
 *
 * ## The timeout case injects a REAL SQLSTATE
 *
 * The classification (`sqlStateOf(error) === '57014'`) exists because drizzle
 * re-wraps the driver error and the SQLSTATE lives on `cause` — the direct
 * `error.code` read this replaces matched nothing, which made the 503 branch
 * unreachable and every timed-out search a 500. A hand-built `{ code: 57014 }`
 * would pass against that broken read too, so the error this suite injects is
 * one the driver actually produced, provoked with `statement_timeout`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  loadShowSensitiveContent: vi.fn(),
  loadMuteWords: vi.fn(),
}));

// Identity hydration: the route is judged on WHICH rows it selected, and a real
// hydration would need Oxy for identities it does not decide anything with here.
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (rows: object[]) => rows) },
}));

vi.mock('../utils/oxyHelpers', () => ({ createScopedOxyClient: vi.fn(() => ({})) }));

vi.mock('../runtime/oxyClient', () => ({
  getRuntimeOxyClient: vi.fn(() => ({ getProfileByUsername: vi.fn(async () => null) })),
}));

/**
 * The viewer's two safety gates, and the injection point for the timeout case.
 *
 * They are the first thing the handler awaits inside its own `try`, so a
 * rejection here reaches the SAME catch a failing query would — which is where
 * the classification being tested lives. Provoking a real timeout on the search
 * query itself would mean racing `statement_timeout` against a pooled
 * connection, which is a flake, not a test.
 */
vi.mock('../services/safety/viewerSafety', () => ({
  loadShowSensitiveContent: mocks.loadShowSensitiveContent,
  loadMuteWords: mocks.loadMuteWords,
}));

vi.mock('../services/viewerFollowGraph', () => ({
  loadFollowedAuthorIds: vi.fn(async () => new Set<string>()),
}));

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { QUERY_CANCELED, sqlStateOf } from '../db/pgErrors';
import { clearPostScope, postScope, seedPost } from './helpers/postFixtures';
import searchRouter from '../routes/search';

const scope = postScope('search-pasted-url');
const AUTHOR = scope.user('author');

/**
 * A hex run tag inside every term and every body.
 *
 * One database serves the whole parallel run, and search is GLOBAL over public
 * published posts — an untagged term like `alice` would match another file's
 * rows and make the "returns exactly this post" controls flaky. Hex only: a
 * uuid's dashes would change how the text-search parser tokenises the term,
 * which is the very thing these fixtures depend on.
 */
const tag = randomUUID().replace(/-/g, '');

/** Every (query, body) pair whose EMPTY answer is the short-circuit's doing. */
const SHORT_CIRCUIT = {
  pastedUrl: {
    query: `https://x.com/t${tag}`,
    body: `https //x.com/t${tag}`,
  },
  uppercaseScheme: {
    query: `HTTPS://X.com/t${tag}`,
    body: `https //x.com/t${tag}`,
  },
  profileUrl: {
    query: `http://mastodon.social/@alice${tag}`,
    body: `http //mastodon.social/@alice${tag}`,
  },
  federatedHandle: {
    query: `@beto${tag}@x.com`,
    body: `beto${tag}@x.com wrote this`,
  },
  bareHandle: {
    query: `@alice${tag}`,
    body: `alice${tag} said hello`,
  },
  paddedHandle: {
    query: `  @alice${tag}@mastodon.social  `,
    body: `alice${tag}@mastodon.social posted`,
  },
} as const;

/** The pairs that must still SEARCH, and return their post. */
const SEARCHED = {
  ordinaryTerm: {
    query: `ordinary${tag}`,
    body: `an ordinary${tag} post body`,
  },
  sentenceWithHandle: {
    query: `@alice${tag} what did you think`,
    body: `alice${tag} what did you think about it`,
  },
  email: {
    query: `nate${tag}@oxy.so`,
    body: `nate${tag}@oxy.so sent mail`,
  },
} as const;

const app = express();
app.use('/search', searchRouter);

async function searchPosts(query: string) {
  return request(app).get('/search').query({ query, type: 'posts' });
}

/** Seed one public, published post carrying `body` as its primary rendition. */
async function seedBody(body: string): Promise<string> {
  const record = await seedPost(scope, {
    oxyUserId: AUTHOR,
    content: { variants: [{ source: 'author', text: body, tag: 'en' }] },
  });
  return record.id;
}

/** Does this body match this query, under the configuration the route uses? */
async function matchesInPostgres(query: string, body: string): Promise<boolean> {
  const rows = await getDb().execute<{ m: boolean }>(
    sql`select to_tsvector('english', ${body}) @@ websearch_to_tsquery('english', ${query}) as m`,
  );
  return rows[0]?.m === true;
}

/**
 * A genuine `57014` from the driver, wrapped exactly as drizzle wraps it.
 *
 * `SET LOCAL` scopes the timeout to this transaction, which drizzle pins to one
 * connection — so nothing else in the run can inherit it.
 */
async function captureQueryCanceledError(): Promise<unknown> {
  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = 1`);
      await tx.execute(sql`select pg_sleep(0.5)`);
    });
  } catch (error) {
    return error;
  }
  throw new Error('expected the statement to be cancelled');
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadShowSensitiveContent.mockResolvedValue(true);
  mocks.loadMuteWords.mockResolvedValue([]);
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('fixture shape (vacuity floor)', () => {
  it.each(Object.entries(SHORT_CIRCUIT))(
    'seeds a post the %s query WOULD match, so an empty answer is the branch',
    async (_name, pair) => {
      // Without this, every short-circuit assertion below is satisfied by a
      // query that ran and matched nothing — which is exactly what Postgres does
      // for a pasted URL on ordinary content, and is the reason the old
      // "assert the empty body" shape could not tell the fix from the bug.
      await expect(matchesInPostgres(pair.query, pair.body)).resolves.toBe(true);
    },
  );

  it.each(Object.entries(SEARCHED))('seeds a post the %s query matches', async (_name, pair) => {
    await expect(matchesInPostgres(pair.query, pair.body)).resolves.toBe(true);
  });

  it('injects an error the DRIVER produced, carrying the real SQLSTATE', async () => {
    // A hand-built `{ code: '57014' }` would also satisfy the 503 case — and
    // would satisfy it against the BROKEN `error.code` read this branch was
    // written to replace, since drizzle puts the SQLSTATE on `cause`.
    const error = await captureQueryCanceledError();
    expect(sqlStateOf(error)).toBe(QUERY_CANCELED);
    expect((error as { code?: unknown }).code).not.toBe(QUERY_CANCELED);
  });
});

describe('GET /search with a pasted URL', () => {
  it('answers empty for a pasted URL even though a post matches it', async () => {
    const postId = await seedBody(SHORT_CIRCUIT.pastedUrl.body);

    const res = await searchPosts(SHORT_CIRCUIT.pastedUrl.query);

    expect(res.status).toBe(200);
    expect(res.body.posts).toEqual([]);
    expect(res.body.hasMore).toBe(false);
    // Named, so the failure says WHICH row came back rather than "not empty".
    expect(res.body.posts.map((post: { id: string }) => post.id)).not.toContain(postId);
  });

  it('still searches an ordinary term, and returns the post', async () => {
    // The control. Without it, "answers empty" is satisfied by a route that
    // answers empty for ANY input — a dead endpoint would pass the case above.
    const postId = await seedBody(SEARCHED.ordinaryTerm.body);

    const res = await searchPosts(SEARCHED.ordinaryTerm.query);

    expect(res.status).toBe(200);
    expect(res.body.posts.map((post: { id: string }) => post.id)).toEqual([postId]);
  });

  it('treats a URL as a URL regardless of scheme case or trailing path', async () => {
    for (const pair of [SHORT_CIRCUIT.uppercaseScheme, SHORT_CIRCUIT.profileUrl]) {
      // eslint-disable-next-line no-await-in-loop
      await seedBody(pair.body);
      // eslint-disable-next-line no-await-in-loop
      const res = await searchPosts(pair.query);
      expect(res.status).toBe(200);
      expect(res.body.posts).toEqual([]);
    }
  });

  it('answers a query that runs out of time with 503, not 500', async () => {
    mocks.loadShowSensitiveContent.mockRejectedValueOnce(await captureQueryCanceledError());

    const res = await searchPosts(`something expensive ${tag}`);

    // A capacity answer, not a fault: 503 says what happened and is retryable,
    // where the 500 it used to send hides a real crash behind the same status.
    expect(res.status).toBe(503);
    expect(res.body.message).toBe('Search timed out');
  });

  it('still answers 500 for a fault that is NOT a timeout', async () => {
    // Distinguishes "classified the timeout" from "stopped returning 500 at all".
    mocks.loadShowSensitiveContent.mockRejectedValueOnce(new Error('something genuinely broken'));

    const res = await searchPosts(`ordinary ${tag}`);

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Error performing search');
  });
});

describe('GET /search with a handle typed alone', () => {
  it.each([
    ['a federated handle', SHORT_CIRCUIT.federatedHandle],
    ['a bare handle', SHORT_CIRCUIT.bareHandle],
    ['a handle padded with whitespace', SHORT_CIRCUIT.paddedHandle],
  ])('answers empty for %s, even though a post matches it', async (_name, pair) => {
    const postId = await seedBody(pair.body);

    const res = await searchPosts(pair.query);

    expect(res.status).toBe(200);
    expect(res.body.posts).toEqual([]);
    expect(res.body.posts.map((post: { id: string }) => post.id)).not.toContain(postId);
  });

  it('still searches a sentence that merely CONTAINS a handle', async () => {
    // ALONE is the condition, and this is what proves it is doing work rather
    // than swallowing every query that mentions somebody. Without it, "answers
    // empty" would also be satisfied by a rule that discarded any text with an
    // `@` in it.
    const postId = await seedBody(SEARCHED.sentenceWithHandle.body);

    const res = await searchPosts(SEARCHED.sentenceWithHandle.query);

    expect(res.status).toBe(200);
    expect(res.body.posts.map((post: { id: string }) => post.id)).toEqual([postId]);
  });

  it('does not mistake an email for a handle', async () => {
    const postId = await seedBody(SEARCHED.email.body);

    const res = await searchPosts(SEARCHED.email.query);

    expect(res.status).toBe(200);
    expect(res.body.posts.map((post: { id: string }) => post.id)).toEqual([postId]);
  });
});
