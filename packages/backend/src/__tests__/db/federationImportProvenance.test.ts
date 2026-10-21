import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../db/postgres';
import {
  federationPostImports,
  federationPostImportReasons,
} from '../../db/schema/federationImports';
import { posts } from '../../db/schema/posts';
import { likes, bookmarks } from '../../db/schema/engagement';
import { federatedFollows } from '../../db/schema/federation';
import { observeFederationImportReason } from '../../db/federation/importProvenanceRepository';
import { clearFederationScope, federationScope, seedPost } from '../helpers/federationFixtures';
import { insertPostRecord, loadPostRecord } from '../../db/posts/postRepository';
import { reportFederationImportReview } from '../../scripts/reportFederationImportReview';

const scope = federationScope('import-provenance');
beforeAll(async () => {
  await connectPostgres();
});
afterEach(async () => {
  await clearFederationScope(scope);
});
afterAll(async () => {
  await closePostgres();
});

async function remote(reason?: 'discovery_backfill' | 'requested_profile') {
  return seedPost(scope, {
    federation: {
      actorUri: `${scope.origin}/actor`,
      activityId: `${scope.origin}/post/${crypto.randomUUID()}`,
      ...(reason ? { importReason: reason } : {}),
    },
  });
}
async function provenance(postId: string) {
  const origins = await getDb()
    .select()
    .from(federationPostImports)
    .where(eq(federationPostImports.postId, postId));
  const reasons = await getDb()
    .select()
    .from(federationPostImportReasons)
    .where(eq(federationPostImportReasons.postId, postId));
  return { origin: origins[0], reasons: reasons.map((row) => row.reason).sort() };
}

describe('private federation import evidence', () => {
  it('records first cause atomically and never exposes it on the public hydration record', async () => {
    const post = await remote('discovery_backfill');
    expect((await provenance(post.id)).origin?.initialReason).toBe('discovery_backfill');
    expect((await loadPostRecord(post.id))?.federation).not.toHaveProperty('importReason');
    expect(await provenance(post.id)).toMatchObject({ reasons: ['discovery_backfill'] });
  });

  it('appends concurrent later reasons without replacing origin or duplicating rows', async () => {
    const post = await remote('discovery_backfill');
    await Promise.all([
      observeFederationImportReason([post.id], 'followed_outbox'),
      observeFederationImportReason([post.id], 'requested_profile'),
      observeFederationImportReason([post.id], 'followed_outbox'),
    ]);
    expect(await provenance(post.id)).toMatchObject({
      origin: { initialReason: 'discovery_backfill' },
      reasons: ['discovery_backfill', 'followed_outbox', 'requested_profile'],
    });
  });

  it('does not invent the initial reason of an old row', async () => {
    const post = await remote();
    expect((await provenance(post.id)).origin).toBeUndefined();
    await observeFederationImportReason([post.id], 'requested_profile');
    expect(await provenance(post.id)).toMatchObject({
      origin: { initialReason: null },
      reasons: ['requested_profile'],
    });
  });

  it('does not attach federation evidence to local or nonexistent posts', async () => {
    const post = await seedPost(scope);
    await observeFederationImportReason([post.id, 'not-a-post'], 'quote_dependency');
    expect(await provenance(post.id)).toEqual({ origin: undefined, reasons: [] });
  });

  it('records native replies, quotes and boosts as reasons to preserve remote originals', async () => {
    const targets = await Promise.all([
      remote('discovery_backfill'),
      remote('discovery_backfill'),
      remote('discovery_backfill'),
    ]);
    const [parent, quote, boost] = targets;
    if (!parent || !quote || !boost) throw new Error('Missing fixtures');
    await seedPost(scope, { parentPostId: parent.id });
    await seedPost(scope, { quoteOf: quote.id });
    await seedPost(scope, { boostOf: boost.id });
    expect((await provenance(parent.id)).reasons).toContain('reply_dependency');
    expect((await provenance(quote.id)).reasons).toContain('quote_dependency');
    expect((await provenance(boost.id)).reasons).toContain('boost_dependency');
  });

  it('rolls back evidence when creating the post fails, and cascades evidence with deletion', async () => {
    const post = await remote('requested_profile');
    const failedId = crypto.randomUUID();
    await expect(
      insertPostRecord({
        ...post,
        id: failedId,
        federation: {
          actorUri: `${scope.origin}/actor`,
          activityId: `${scope.origin}/failed`,
          importReason: 'requested_profile',
        },
        authorship: [...post.authorship, ...post.authorship],
      }),
    ).rejects.toThrow();
    expect((await provenance(failedId)).origin).toBeUndefined();
    await getDb().delete(posts).where(eq(posts.id, post.id));
    expect(await provenance(post.id)).toEqual({ origin: undefined, reasons: [] });
  });
});

describe('read-only import review', () => {
  it('protects unknown and discovery-only rows when the authoritative follow graph is unverified', async () => {
    const legacy = await remote();
    const discovery = await remote('discovery_backfill');
    const requested = await remote('requested_profile');
    await seedPost(scope, { quoteOf: discovery.id });
    const ids = [legacy.id, discovery.id, requested.id];
    const before = await getDb()
      .select()
      .from(federationPostImports)
      .where(inArray(federationPostImports.postId, ids));
    const report = await reportFederationImportReview({ postIds: ids });
    expect(report.dryRun).toBe(true);
    expect(report.rows).toHaveLength(3);
    for (const row of report.rows) {
      expect(row.disposition).toBe('protected');
      expect(row.protectionReasons).toContain('authoritative_follow_graph_unverified');
    }
    expect(report.rows.find((row) => row.id === legacy.id)?.protectionReasons).toContain(
      'unknown_initial_import',
    );
    expect(report.rows.find((row) => row.id === discovery.id)?.protectionReasons).toContain(
      'referenced_by_post',
    );
    expect(report.rows.find((row) => row.id === requested.id)?.protectionReasons).toContain(
      'required_or_requested_import',
    );
    expect(
      await getDb()
        .select()
        .from(federationPostImports)
        .where(inArray(federationPostImports.postId, ids)),
    ).toEqual(before);
  });

  it('reports follow, engagement, saved and viewed protections without naming their users', async () => {
    const post = await remote('discovery_backfill');
    const db = getDb();
    await db.insert(federatedFollows).values({
      localUserId: scope.localUserId,
      remoteActorUri: `${scope.origin}/actor`,
      direction: 'outbound',
      status: 'accepted',
    });
    await db.insert(likes).values({ userId: scope.localUserId, postId: post.id });
    await db.insert(bookmarks).values({ userId: scope.localUserId, postId: post.id });
    await db.update(posts).set({ statsViewsCount: 1 }).where(eq(posts.id, post.id));
    const [row] = (await reportFederationImportReview({ postIds: [post.id] })).rows;
    expect(row?.protectionReasons).toEqual(
      expect.arrayContaining(['accepted_protocol_follow', 'engagement', 'saved', 'viewed']),
    );
    expect(row?.discoveryOnlyWithoutKnownNeed).toBe(false);
    expect(JSON.stringify(row)).not.toContain(scope.localUserId);
  });

  it('flags discovery-only rows for review while retaining the unverified-graph protection', async () => {
    const post = await remote('discovery_backfill');
    const [row] = (await reportFederationImportReview({ postIds: [post.id] })).rows;
    expect(row?.discoveryOnlyWithoutKnownNeed).toBe(true);
    expect(row?.disposition).toBe('protected');
    expect(row?.protectionReasons).toContain('authoritative_follow_graph_unverified');
  });

  it.each(['statsLikesCount', 'statsBoostsCount', 'statsCommentsCount'] as const)(
    'protects remote activity reported only by %s',
    async (counter) => {
      const post = await remote('discovery_backfill');
      await getDb()
        .update(posts)
        .set({ [counter]: 1 })
        .where(eq(posts.id, post.id));
      const [row] = (await reportFederationImportReview({ postIds: [post.id] })).rows;
      expect(row?.hasEngagement).toBe(true);
      expect(row?.protectionReasons).toContain('engagement');
      expect(row?.discoveryOnlyWithoutKnownNeed).toBe(false);
    },
  );

  it('bounds requests and never includes nonpublic content', async () => {
    const post = await remote('discovery_backfill');
    await getDb().update(posts).set({ visibility: 'private' }).where(eq(posts.id, post.id));
    expect((await reportFederationImportReview({ postIds: [post.id] })).rows).toEqual([]);
    await expect(reportFederationImportReview({ limit: 501 })).rejects.toThrow('limit must be');
  });
});
