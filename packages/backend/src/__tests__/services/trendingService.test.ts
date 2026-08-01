/**
 * Trending AGGREGATION, against real rows.
 *
 * What is being asserted is the SAFETY GATE and the two topic sources, because
 * both fail silently. The suite this replaces asserted the shape of a Mongo
 * `$match` object — it could tell you the pipeline named `metadata.isSensitive`,
 * and nothing at all about whether a sensitive post ever reached a trend.
 *
 * The two branches of `aggregateTopics` are the other silent one. Mongo chose
 * between the canonical `topicRefs` and the slug-only baseline with a `$cond`;
 * Postgres has to express it as a `union all` whose slug branch carries a
 * `not exists`, and dropping that predicate double-counts every post that has
 * both — a plausible-looking number, never an error.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

// Trending pulls in side-effecting collaborators the aggregations never touch.
vi.mock('../../utils/socket', () => ({ emitTrendsUpdated: vi.fn() }));
vi.mock('../../utils/alia', () => ({ aliaChat: vi.fn(), isAliaEnabled: () => false }));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { postClassificationTopicRefs } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import { trendingService } from '../../services/TrendingService';

/**
 * `aggregateHashtags` / `aggregateTopics` are private; reach them through a typed
 * structural view rather than `as any`, so the tests stay type-checked.
 */
type PrivateTrending = {
  aggregateHashtags(): Promise<Array<{ name: string; volume: number; momentum: number; score: number }>>;
  aggregateTopics(): Promise<Array<{ name: string; type: string; volume: number; score: number }>>;
};
const svc = trendingService as unknown as PrivateTrending;

let db: Database;
const createdPostIds: string[] = [];

/** Inside the 24-hour window but OUTSIDE the six-hour one, so momentum is 0. */
const STALE = new Date(Date.now() - 12 * 60 * 60 * 1000);

/** A slug unique to this run — sibling suites share the database and the table. */
function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

interface SeedOptions {
  hashtags?: string[];
  classificationTopics?: string[];
  topicRefs?: Array<{ name: string; relevance?: number; type?: 'topic' | 'entity' }>;
  createdAt?: Date;
  status?: 'published' | 'draft';
  visibility?: 'public' | 'private';
  classificationSensitive?: boolean;
  metadataIsSensitive?: boolean;
  federationSensitive?: boolean;
  isBoost?: boolean;
}

async function seedPost(options: SeedOptions = {}): Promise<string> {
  const [row] = await db
    .insert(posts)
    .values({
      status: options.status ?? 'published',
      visibility: options.visibility ?? 'public',
      createdAt: options.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
      hashtags: options.hashtags,
      classificationTopics: options.classificationTopics,
      classificationSensitive: options.classificationSensitive,
      metadataIsSensitive: options.metadataIsSensitive ?? false,
      federationSensitive: options.federationSensitive,
    })
    .returning({ id: posts.id });
  createdPostIds.push(row.id);

  if (options.isBoost) {
    // A boost points at an original; the aggregations exclude anything that does.
    await db.update(posts).set({ boostOf: row.id }).where(inArray(posts.id, [row.id]));
  }
  if (options.topicRefs?.length) {
    await db.insert(postClassificationTopicRefs).values(
      options.topicRefs.map((ref) => ({
        postId: row.id,
        name: ref.name,
        relevance: ref.relevance ?? null,
        type: ref.type ?? null,
      })),
    );
  }
  return row.id;
}

/** Trends whose name is one of `names` — a sibling suite's rows can never match. */
function mine<T extends { name: string }>(trends: T[], names: string[]): T[] {
  return trends.filter((trend) => names.includes(trend.name));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdPostIds.length > 0) {
    // `post_classification_topic_refs` cascades from the post.
    await db.delete(posts).where(inArray(posts.id, createdPostIds));
    createdPostIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('aggregateHashtags — the safety gate is in the QUERY, not after it', () => {
  it('counts an ordinary hashtag and excludes every sensitive flag', async () => {
    /**
     * Each of the three flags is INDEPENDENTLY sufficient, and each is nullable
     * in a different way (`classification_sensitive` and `federation_sensitive`
     * are NULL on most posts, `metadata_is_sensitive` never is). That is why the
     * clause is `is not true` and not `= false`: with `<> true`, a NULL makes the
     * whole predicate NULL and EVERY unclassified post would silently vanish from
     * trending. The clean post below is what catches that.
     */
    const tag = uniqueSlug('cleantag');
    await seedPost({ hashtags: [tag] });
    await seedPost({ hashtags: [tag], classificationSensitive: true });
    await seedPost({ hashtags: [tag], metadataIsSensitive: true });
    await seedPost({ hashtags: [tag], federationSensitive: true });

    const trends = mine(await svc.aggregateHashtags(), [tag]);

    expect(trends).toHaveLength(1);
    expect(trends[0].volume).toBe(1);
  });

  it('excludes drafts, private posts, boosts, and posts outside the 24-hour window', async () => {
    const tag = uniqueSlug('windowtag');
    await seedPost({ hashtags: [tag] });
    await seedPost({ hashtags: [tag], status: 'draft' });
    await seedPost({ hashtags: [tag], visibility: 'private' });
    await seedPost({ hashtags: [tag], isBoost: true });
    await seedPost({ hashtags: [tag], createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) });

    const trends = mine(await svc.aggregateHashtags(), [tag]);

    expect(trends).toHaveLength(1);
    expect(trends[0].volume).toBe(1);
  });

  it('counts the six-hour subset separately, driving momentum', async () => {
    // Two posts, one of them recent: momentum = (recent * 4) / total, capped at 1.
    const tag = uniqueSlug('momentumtag');
    await seedPost({ hashtags: [tag], createdAt: new Date(Date.now() - 60 * 1000) });
    await seedPost({ hashtags: [tag], createdAt: new Date(Date.now() - 20 * 60 * 60 * 1000) });

    const [trend] = mine(await svc.aggregateHashtags(), [tag]);

    expect(trend.volume).toBe(2);
    expect(trend.momentum).toBeCloseTo(1, 10); // (1 * 4) / 2 = 2, capped at 1
    expect(trend.score).toBeCloseTo(2 * (1 + 2 * 0.5), 10);
  });

  it('drops blocklisted NSFW hashtags even when the post itself is clean', async () => {
    // The post carries no sensitive flag at all, so the query-level gate lets it
    // through; the blocklist filter after the aggregation is what removes it.
    const clean = uniqueSlug('technology');
    await seedPost({ hashtags: [clean, 'nsfw', 'Sexy'] });

    const trends = await svc.aggregateHashtags();

    expect(mine(trends, [clean])).toHaveLength(1);
    expect(trends.map((t) => t.name)).not.toContain('nsfw');
    expect(trends.map((t) => t.name)).not.toContain('sexy');
  });

  it('counts every hashtag on a post, not just the first', async () => {
    const first = uniqueSlug('first');
    const second = uniqueSlug('second');
    await seedPost({ hashtags: [first, second] });

    const trends = mine(await svc.aggregateHashtags(), [first, second]);

    expect(trends.map((t) => t.volume)).toEqual([1, 1]);
  });
});

describe('aggregateTopics — canonical refs, with the slug list as an EXCLUSIVE fallback', () => {
  it('prefers canonical refs and does not also count the post\'s slug list', async () => {
    /**
     * The `not exists` in the slug branch. Without it this post contributes to
     * BOTH branches: `canonical` counts 2 instead of 1, `legacy` appears at all,
     * and the resulting volumes look entirely plausible.
     */
    const canonical = uniqueSlug('canonical');
    const legacy = uniqueSlug('legacy');
    for (let i = 0; i < 2; i += 1) {
      await seedPost({
        classificationTopics: [legacy],
        topicRefs: [{ name: canonical, relevance: 8 }],
      });
    }

    const trends = await svc.aggregateTopics();

    expect(mine(trends, [canonical]).map((t) => t.volume)).toEqual([2]);
    expect(mine(trends, [legacy])).toEqual([]);
  });

  it('falls back to the slug list for a post that resolved no refs', async () => {
    const slugOnly = uniqueSlug('slugonly');
    // Older than the six-hour window, so momentum is 0 and `score` is exactly the
    // summed relevance — the thing under test — rather than relevance x 1.5.
    for (let i = 0; i < 2; i += 1) await seedPost({ classificationTopics: [slugOnly], createdAt: STALE });

    const [trend] = mine(await svc.aggregateTopics(), [slugOnly]);

    expect(trend.volume).toBe(2);
    expect(trend.type).toBe('topic');
    // Slug topics carry no relevance, so each contributes the neutral default (5).
    expect(trend.score).toBeCloseTo(10, 10);
  });

  it('sums a ref\'s declared relevance and defaults a missing one to the neutral value', async () => {
    const declared = uniqueSlug('declared');
    const missing = uniqueSlug('missing');
    for (let i = 0; i < 2; i += 1) {
      await seedPost({
        topicRefs: [{ name: declared, relevance: 9 }, { name: missing }],
        createdAt: STALE,
      });
    }

    const trends = await svc.aggregateTopics();

    expect(mine(trends, [declared])[0].score).toBeCloseTo(18, 10);
    expect(mine(trends, [missing])[0].score).toBeCloseTo(10, 10);
  });

  it('keeps a name that is both a topic and an entity as TWO trends', async () => {
    // The same collision the batch uniqueness key exists for, one layer earlier.
    const shared = uniqueSlug('shared');
    for (let i = 0; i < 2; i += 1) {
      await seedPost({ topicRefs: [{ name: shared, type: 'topic' }] });
      await seedPost({ topicRefs: [{ name: shared, type: 'entity' }] });
    }

    const trends = mine(await svc.aggregateTopics(), [shared]);

    expect(trends.map((t) => t.type).sort()).toEqual(['entity', 'topic']);
  });

  it('requires at least two posts before a topic trends', async () => {
    const lonely = uniqueSlug('lonely');
    await seedPost({ topicRefs: [{ name: lonely }] });

    expect(mine(await svc.aggregateTopics(), [lonely])).toEqual([]);
  });

  it('excludes sensitive posts and NSFW slugs from topics too', async () => {
    const clean = uniqueSlug('cleantopic');
    for (let i = 0; i < 2; i += 1) await seedPost({ topicRefs: [{ name: clean }] });
    for (let i = 0; i < 4; i += 1) {
      await seedPost({ topicRefs: [{ name: clean }], classificationSensitive: true });
      await seedPost({ topicRefs: [{ name: 'porn' }] });
    }

    const trends = await svc.aggregateTopics();

    expect(mine(trends, [clean]).map((t) => t.volume)).toEqual([2]);
    expect(trends.map((t) => t.name)).not.toContain('porn');
  });
});
