import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
import type { ChannelWritersResponse } from '@mention/shared-types';
import type { OxyAuthRequest } from '@oxyhq/core/server';

/**
 * `GET /channels/:oxyUserId/writers` — the list behind a channel's writers tab.
 *
 * ## Why this file was rewritten rather than repaired
 *
 * The version this replaces mocked `models/Post` and ran the route's Mongo
 * aggregation pipeline through a hand-written evaluator. That was a reasonable
 * shape while Mongo was the store; post-cutover it is a check pointed at the
 * ABANDONED one — the route now issues a drizzle `GROUP BY`, so every assertion
 * about which posts count was an assertion about an evaluator no code path
 * reaches. It could not have failed however wrong the real query became.
 *
 * The posts and the settings are real rows now, so "which posts count" is
 * answered by Postgres. Only the two genuinely remote things are stubbed: the Oxy
 * identity resolver and the Oxy follow check.
 *
 * ## The gate IS the feature
 *
 * Three conditions have to hold and each fails closed: the account resolves as a
 * CHANNEL, its settings say `signPosts === true`, and this reader may see the
 * channel at all. Every refusal is the same 404, so a caller cannot use the
 * status code to learn which condition failed.
 *
 * `channelWriterDisclosure` is left REAL — the consent decision is read from a
 * real `user_settings` row — so these are tests of the actual gate rather than of
 * a stub that agrees with it. `requiresAccessCheck` and `degradedActorSummary`
 * are real for the same reason.
 */

const resolveUserSummaries = vi.hoisted(() => vi.fn());
const checkFollowAccess = vi.hoisted(() => vi.fn());

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: (...args: unknown[]) => resolveUserSummaries(...args),
}));

vi.mock('../../utils/privacyHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/privacyHelpers')>();
  return {
    // `requiresAccessCheck` stays REAL — it is the pure half of the visibility
    // rule, and stubbing it would make the private-channel cases test nothing.
    requiresAccessCheck: actual.requiresAccessCheck,
    checkFollowAccess: (...args: unknown[]) => checkFollowAccess(...args),
  };
});

vi.mock('../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/oxyHelpers')>()),
  createUserScopedOxyServices: vi.fn(() => ({})),
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { userSettings } from '../../db/schema/userProfile';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import channelWritersRouter from '../../routes/channelWriters.routes';

const scope = serviceScope('channel-writers');
const CHANNEL = scope.user('channel');
const OTHER_ACCOUNT = scope.user('other-account');
const VIEWER = scope.user('viewer');
const WRITER_A = scope.user('writer-a');
const WRITER_B = scope.user('writer-b');
const WRITER_C = scope.user('writer-c');
const SCOPE_PREFIX = `oxy-${scope.name}-`;

/** A summary map in the shape `resolveUserSummaries` answers with. */
function summariesFor(ids: readonly string[]): Map<string, { user: unknown }> {
  return new Map(
    ids.map((id) => [
      id,
      {
        user: {
          id,
          username: id,
          name: { displayName: id },
          kind: id === CHANNEL ? 'channel' : 'personal',
        },
      },
    ]),
  );
}

function buildApp(viewerId?: string) {
  const app = express();
  app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
    if (viewerId) req.user = { id: viewerId };
    next();
  });
  app.use('/channels', channelWritersRouter);
  return app;
}

/** One published channel post, written by `writer`, at a chosen instant. */
async function seedSignedPost(
  writer: string | null,
  createdAt: Date,
  overrides: Parameters<typeof seedPost>[1] = {},
): Promise<void> {
  const post = await seedPost(scope, {
    oxyUserId: CHANNEL,
    writtenByOxyUserId: writer,
    ...overrides,
  });
  // `created_at` carries a `now()` default and the record writer does not accept
  // one, so the ordering the route sorts on is set explicitly rather than being
  // whatever insertion order produced.
  await getDb().update(posts).set({ createdAt }).where(eq(posts.id, post.id));
}

/** Turn the channel's disclosure on (or off). */
async function setSignPosts(value: boolean | null): Promise<void> {
  await getDb()
    .insert(userSettings)
    .values({ oxyUserId: CHANNEL, channelAccountSignPosts: value })
    .onConflictDoUpdate({
      target: userSettings.oxyUserId,
      set: { channelAccountSignPosts: value },
    });
}

/**
 * The payload, out of the `{ data }` envelope `sendSuccessResponse` answers in.
 *
 * Read through ONE helper rather than reaching into `res.body` at each site: the
 * envelope is easy to drop when a test is re-pointed at a new store, and
 * `res.body` is always an object, so the mistake surfaces as `undefined` where a
 * list was expected instead of as a failure that names the envelope.
 */
const payload = (body: unknown): ChannelWritersResponse =>
  (body as { data: ChannelWritersResponse }).data;

const writerIds = (body: unknown): string[] =>
  payload(body).writers.map((row) => row.writer.id);

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  resolveUserSummaries.mockImplementation(async (ids: readonly string[]) => summariesFor(ids));
  checkFollowAccess.mockResolvedValue(true);
  await setSignPosts(true);
});

afterEach(async () => {
  await getDb().delete(userSettings).where(like(userSettings.oxyUserId, `${SCOPE_PREFIX}%`));
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /channels/:oxyUserId/writers — the gate', () => {
  it('404s an account that is not a channel', async () => {
    resolveUserSummaries.mockImplementation(async (ids: readonly string[]) => {
      const map = summariesFor(ids);
      map.set(CHANNEL, { user: { id: CHANNEL, username: CHANNEL, kind: 'personal' } });
      return map;
    });
    await seedSignedPost(WRITER_A, new Date('2026-01-01T00:00:00Z'));

    const res = await request(buildApp()).get(`/channels/${CHANNEL}/writers`);

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('No writers list for that account');
  });

  it('404s a channel that has not opted into naming its writers', async () => {
    await setSignPosts(false);
    await seedSignedPost(WRITER_A, new Date('2026-01-01T00:00:00Z'));

    const res = await request(buildApp()).get(`/channels/${CHANNEL}/writers`);

    expect(res.status).toBe(404);
  });

  it('404s a channel with no settings row at all', async () => {
    // Fail-closed at the missing-row case: `null`, `false` and "no row" must every
    // one of them mean anonymous, which is what an identity check gives and what
    // any looser read would get wrong in the DISCLOSING direction.
    await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, CHANNEL));
    await seedSignedPost(WRITER_A, new Date('2026-01-01T00:00:00Z'));

    const res = await request(buildApp()).get(`/channels/${CHANNEL}/writers`);

    expect(res.status).toBe(404);
  });

  it('404s a NULL sign-posts flag, which means "not a channel account"', async () => {
    await setSignPosts(null);
    await seedSignedPost(WRITER_A, new Date('2026-01-01T00:00:00Z'));

    const res = await request(buildApp()).get(`/channels/${CHANNEL}/writers`);

    expect(res.status).toBe(404);
  });

  it('404s a restricted channel for a reader who may not see it', async () => {
    await getDb()
      .update(userSettings)
      .set({ privacyProfileVisibility: 'private' })
      .where(eq(userSettings.oxyUserId, CHANNEL));
    checkFollowAccess.mockResolvedValue(false);
    await seedSignedPost(WRITER_A, new Date('2026-01-01T00:00:00Z'));

    const res = await request(buildApp(VIEWER)).get(`/channels/${CHANNEL}/writers`);

    expect(res.status).toBe(404);
  });

  it('404s a restricted channel for an anonymous reader WITHOUT asking Oxy', async () => {
    // An anonymous reader can never satisfy a restricted profile, so the upstream
    // call is not even made for one.
    await getDb()
      .update(userSettings)
      .set({ privacyProfileVisibility: 'private' })
      .where(eq(userSettings.oxyUserId, CHANNEL));
    await seedSignedPost(WRITER_A, new Date('2026-01-01T00:00:00Z'));

    const res = await request(buildApp()).get(`/channels/${CHANNEL}/writers`);

    expect(res.status).toBe(404);
    expect(checkFollowAccess).not.toHaveBeenCalled();
  });

  it('200s a disclosing channel — without this the gate could be refusing everything', async () => {
    // The control. Every assertion above is satisfied by a route that always
    // 404s, so one of them has to prove the gate lets a real list through.
    await seedSignedPost(WRITER_A, new Date('2026-01-01T00:00:00Z'));

    const res = await request(buildApp()).get(`/channels/${CHANNEL}/writers`);

    expect(res.status).toBe(200);
    expect(writerIds(res.body)).toEqual([WRITER_A]);
  });

  it('200s with an EMPTY list for a disclosing channel that has published nothing signed', async () => {
    // A different fact from a refusal, and it has to stay a different status: the
    // list exists and is empty.
    await seedSignedPost(null, new Date('2026-01-01T00:00:00Z'));

    const res = await request(buildApp()).get(`/channels/${CHANNEL}/writers`);

    expect(res.status).toBe(200);
    expect(payload(res.body).writers).toEqual([]);
  });
});

describe('GET /channels/:oxyUserId/writers — what counts', () => {
  it('counts only public, published posts the channel OWNS that name a writer', async () => {
    await seedSignedPost(WRITER_A, new Date('2026-01-05T00:00:00Z'));
    // Each of these must drop out, and each for its own reason. Deleting any one
    // term from the route's WHERE clause puts one of them in the answer.
    await seedSignedPost(WRITER_B, new Date('2026-01-06T00:00:00Z'), { visibility: 'private' });
    await seedSignedPost(WRITER_B, new Date('2026-01-07T00:00:00Z'), { status: 'draft' });
    await seedSignedPost(null, new Date('2026-01-08T00:00:00Z'));
    await seedPost(scope, { oxyUserId: OTHER_ACCOUNT, writtenByOxyUserId: WRITER_C });

    const res = await request(buildApp()).get(`/channels/${CHANNEL}/writers`);

    expect(res.status).toBe(200);
    expect(writerIds(res.body)).toEqual([WRITER_A]);
  });

  it('orders writers by their most recent post, and reports that instant', async () => {
    await seedSignedPost(WRITER_A, new Date('2026-01-01T00:00:00Z'));
    await seedSignedPost(WRITER_B, new Date('2026-01-03T00:00:00Z'));
    await seedSignedPost(WRITER_A, new Date('2026-01-02T00:00:00Z'));

    const res = await request(buildApp()).get(`/channels/${CHANNEL}/writers`);

    expect(writerIds(res.body)).toEqual([WRITER_B, WRITER_A]);
    // A writer's timestamp is the MAX over their posts, not whichever one the
    // grouping happened to see last.
    expect(payload(res.body).writers[1].lastPostAt).toBe(new Date('2026-01-02T00:00:00Z').toISOString());
  });

  it('pages by keyset, without repeating or skipping a writer', async () => {
    await seedSignedPost(WRITER_A, new Date('2026-01-01T00:00:00Z'));
    await seedSignedPost(WRITER_B, new Date('2026-01-02T00:00:00Z'));
    await seedSignedPost(WRITER_C, new Date('2026-01-03T00:00:00Z'));

    const first = await request(buildApp()).get(`/channels/${CHANNEL}/writers?limit=2`);
    expect(writerIds(first.body)).toEqual([WRITER_C, WRITER_B]);
    expect(payload(first.body).nextCursor).toBeTruthy();

    const second = await request(buildApp()).get(
      `/channels/${CHANNEL}/writers?limit=2&cursor=${encodeURIComponent(payload(first.body).nextCursor ?? '')}`,
    );

    // The cursor compares against `max(created_at)`, an AGGREGATE of the group.
    // Applied as a WHERE instead of a HAVING it would drop individual POSTS older
    // than the cursor and then report each writer's most recent SURVIVING post —
    // so a writer reappears page after page with a receding timestamp and the
    // paging never ends. That is what this asserts.
    expect(writerIds(second.body)).toEqual([WRITER_A]);
    expect(payload(second.body).nextCursor).toBeUndefined();
  });

  it('keeps a multi-post writer off the second page', async () => {
    // The sharper version of the case above: WRITER_C has an OLD post as well as
    // a new one, so a WHERE-based cursor would re-emit them on page two dated by
    // the old post. One page-one writer with a post on both sides of the cursor is
    // the only fixture that tells the two spellings apart.
    await seedSignedPost(WRITER_C, new Date('2026-01-03T00:00:00Z'));
    await seedSignedPost(WRITER_C, new Date('2025-12-01T00:00:00Z'));
    await seedSignedPost(WRITER_B, new Date('2026-01-02T00:00:00Z'));
    await seedSignedPost(WRITER_A, new Date('2026-01-01T00:00:00Z'));

    const first = await request(buildApp()).get(`/channels/${CHANNEL}/writers?limit=2`);
    expect(writerIds(first.body)).toEqual([WRITER_C, WRITER_B]);

    const second = await request(buildApp()).get(
      `/channels/${CHANNEL}/writers?limit=2&cursor=${encodeURIComponent(payload(first.body).nextCursor ?? '')}`,
    );

    expect(writerIds(second.body)).toEqual([WRITER_A]);
  });

  it('falls back to a degraded summary rather than surfacing a raw account id', async () => {
    await seedSignedPost(WRITER_A, new Date('2026-01-01T00:00:00Z'));
    let call = 0;
    resolveUserSummaries.mockImplementation(async (ids: readonly string[]) => {
      call += 1;
      // The channel resolve succeeds; the WRITER batch fails.
      if (call === 1) return summariesFor(ids);
      throw new Error('identity is down');
    });

    const res = await request(buildApp()).get(`/channels/${CHANNEL}/writers`);

    expect(res.status).toBe(200);
    expect(payload(res.body).writers).toHaveLength(1);
    expect(
      payload(res.body).writers[0].writer.username,
      'a raw oxyUserId must never surface as a handle',
    ).not.toBe(WRITER_A);
  });

  it('treats a malformed cursor as the first page rather than a 500', async () => {
    await seedSignedPost(WRITER_A, new Date('2026-01-01T00:00:00Z'));

    const res = await request(buildApp()).get(`/channels/${CHANNEL}/writers?cursor=not-a-cursor`);

    expect(res.status).toBe(200);
    expect(writerIds(res.body)).toEqual([WRITER_A]);
  });

  it('400s an over-long account id rather than putting it in a query', async () => {
    const res = await request(buildApp()).get(`/channels/${'x'.repeat(65)}/writers`);

    expect(res.status).toBe(400);
  });
});
