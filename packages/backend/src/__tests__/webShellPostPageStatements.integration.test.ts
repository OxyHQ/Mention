import { lookupManyOf } from './helpers/oxyLookup';
import { adultSafetyFixture } from './helpers/adultSafety';
/**
 * What ONE `/p/:id` page costs the database, measured with the REAL hydration.
 *
 * `/p/:id` is Mention's busiest route by statements: production logged 26.1
 * statements per request over 42,971 requests in three hours (2026-11-28), most
 * of them crawlers walking the long tail, where no cache is warm. The route
 * suite (`webShellRoutes.integration.test.ts`) doubles the hydration, so it
 * cannot see what a page costs; this file runs every Mention read for real
 * against real rows and counts the statements by table, cold, as a crawler's
 * first visit is.
 *
 * It is a BUDGET, not a law of nature: a genuinely new read on this path
 * changes the number here in the same commit, with a reason.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/moderation/crowdSourceClient', () => ({
  getCrowdSourceClient: () => ({ communityNotes: { shown: async () => [] } }),
}));

const { getUsersByIds, byUsernameInScope } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  byUsernameInScope: vi.fn(),
}));

vi.mock('../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    users: { get: vi.fn() },
    follows: { following: vi.fn(async () => []), followers: vi.fn(async () => []) },
  }),
}));

vi.mock('../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    safety: adultSafetyFixture(),
    users: {
      getMany: getUsersByIds,
      lookupMany: lookupManyOf((ids: string[]) => getUsersByIds(ids)),
      byUsername: byUsernameInScope,
    },
    assets: { publicUrl: (id: string) => `https://cdn.test/${id}` },
    getClarityDocuments: vi.fn(async () => ({})),
    withCallOptions: () => ({ users: { byUsername: byUsernameInScope } }),
  }),
}));

vi.mock('../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

import express from 'express';
import request from 'supertest';
import { inArray } from 'drizzle-orm';
import { config } from '../config';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { userSettings } from '../db/schema/userProfile';
import webShellRoutes from '../routes/webShell.routes';
import { metrics } from '../utils/metrics';
import { clearPostScope, postScope, seedPost } from './helpers/postFixtures';

const scope = postScope('p-page-statements');
const AUTHOR = scope.user('author');
const REPLIER_A = scope.user('replier-a');
const REPLIER_B = scope.user('replier-b');
const PEOPLE = [AUTHOR, REPLIER_A, REPLIER_B];

const SHELL =
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Mention</title></head>' +
  '<body><div id="root"></div></body></html>';

async function statementsByTable(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const { labels, count } of metrics.getSeries('db_query_duration_ms')) {
    counts.set(labels.table, (counts.get(labels.table) ?? 0) + count);
  }
  return counts;
}

function total(counts: Map<string, number>): number {
  return [...counts.values()].reduce((sum, n) => sum + n, 0);
}

let previousInstrumentationSetting = false;

beforeAll(async () => {
  previousInstrumentationSetting = config.postgres.queryMetricsEnabled;
  config.postgres.queryMetricsEnabled = true;
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
  config.postgres.queryMetricsEnabled = previousInstrumentationSetting;
});

beforeEach(async () => {
  getUsersByIds.mockReset();
  getUsersByIds.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, username: id, name: { displayName: id }, badges: [], verified: false })),
  );
  byUsernameInScope.mockReset();
  byUsernameInScope.mockImplementation(async (handle: string) => ({
    id: handle,
    username: handle,
    name: { displayName: handle },
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, text: async () => SHELL }) as unknown as Response),
  );
  await getDb()
    .insert(userSettings)
    .values(PEOPLE.map((oxyUserId) => ({ oxyUserId, privacyProfileVisibility: 'public' as const })))
    .onConflictDoNothing();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearPostScope(scope);
  await getDb().delete(userSettings).where(inArray(userSettings.oxyUserId, PEOPLE));
});

async function seedThread(): Promise<string> {
  const post = await seedPost(scope, {
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    content: { variants: [{ source: 'author', text: 'the post a crawler reads', tag: 'en' }] },
    stats: { commentsCount: 3 } as never,
  });
  for (const [index, replier] of [REPLIER_A, REPLIER_B, REPLIER_A].entries()) {
    await seedPost(scope, {
      oxyUserId: replier,
      authorship: [{ oxyUserId: replier, role: 'owner', status: 'accepted' }],
      parentPostId: post.id,
      content: { variants: [{ source: 'author', text: `reply number ${index}`, tag: 'en' }] },
    });
  }
  return post.id;
}

describe('/p/:id statements, cold', () => {
  it('stays within its budget for a post with replies', async () => {
    const postId = await seedThread();
    const app = express();
    app.use('/', webShellRoutes);

    metrics.reset();
    const res = await request(app).get(`/p/${postId}`).set('User-Agent', 'Googlebot/2.1');

    expect(res.status).toBe(200);
    expect(res.text).toContain('the post a crawler reads');
    expect(res.text).toContain('reply number 2');
    const counts = await statementsByTable();
    // 25, from 52 before `readPostChildTables` read the ten child tables in ONE
    // statement. The page assembles three post sets: the post (record cache
    // miss), its newest replies, and — inside the replies' hydration — their
    // parent, which in production is a record-cache HIT because the first read
    // just filled it. Each set is now `posts` + one child statement (labelled
    // `post_authorships`, its first table); it was `posts` + ten.
    expect(counts.get('posts')).toBe(4);
    expect(counts.get('post_authorships')).toBe(3);
    for (const table of [
      'post_content_variants',
      'post_media',
      'post_attachments',
      'post_sources',
      'post_mentions',
      'post_recipients',
      'post_classification_topic_refs',
      'post_variant_media',
      'post_variant_alt_texts',
    ]) {
      expect(counts.get(table)).toBeUndefined();
    }
    expect(total(counts)).toBe(25);
  });
});
