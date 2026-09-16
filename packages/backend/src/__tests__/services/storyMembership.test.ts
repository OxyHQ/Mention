import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  saveStoryMemberships,
  scoreContextualStoryMembership,
  scoreStoryMembership,
} from '../../services/trending/storyMembership';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { trending, trendStoryPosts } from '../../db/schema/discovery';
import { posts } from '../../db/schema/posts';
import { createCluster } from '../../db/posts/postEquivalenceRepository';

describe('deterministic story membership', () => {
  it('keeps the representative term authoritative', () => {
    expect(scoreStoryMembership('trump', ['trump', 'white house'], ['trump']).relevance)
      .toBeGreaterThanOrEqual(0.5);
  });

  it('rejects an incidental weak member on its own', () => {
    expect(scoreStoryMembership('trump', ['trump', 'white house'], ['white house']).relevance)
      .toBeLessThan(0.5);
  });

  it('accepts a post carrying the coherent story together', () => {
    const result = scoreStoryMembership(
      'trump',
      ['trump', 'white house'],
      ['fanta', 'trump', 'white house'],
    );
    expect(result.relevance).toBe(1);
    expect(result.matchedTerms).toEqual(['trump', 'white house']);
  });

  it('does not admit a singleton story when the term is absent', () => {
    expect(scoreStoryMembership('oil', ['oil'], ['fanta']).relevance).toBe(0);
  });
});

describe('scoreContextualStoryMembership', () => {
  it('lets links and quoted posts corroborate an author-written match', () => {
    expect(scoreContextualStoryMembership({
      storyName: 'trump',
      storyTerms: ['trump', 'white house'],
      trendTerms: ['trump'],
      hashtags: [],
      linkTitleTerms: ['white house'],
      quotedTerms: ['trump'],
    })).toEqual({
      relevance: 1,
      matchedTerms: ['trump', 'white house'],
      sources: ['author-term', 'link-title', 'quoted-post'],
    });
  });

  it('never admits an unrelated post from link metadata alone', () => {
    expect(scoreContextualStoryMembership({
      storyName: 'trump',
      storyTerms: ['trump', 'white house'],
      trendTerms: ['fanta'],
      hashtags: [],
      linkTitleTerms: ['trump', 'white house'],
    })).toEqual({ relevance: 0, matchedTerms: [], sources: [] });
  });
});


/**
 * A story's members, against real rows.
 *
 * The scoring above decides whether ONE post belongs; this decides which posts
 * were ever offered to it, and that read had drifted from the rest of its
 * module family. `trendDetection` counts a Meta cross-post's term volume once
 * and `trendExcerpts` quotes it once, because both exclude the collapsed half of
 * an equivalence cluster — so a story that listed the Instagram copy and the
 * Threads copy as two members was reporting two pieces of evidence for a volume
 * of one. See `#990`, and `crosspostCollapseSurfaces.test.ts` for the reader
 * surfaces that answer the same question.
 */
describe('saveStoryMemberships — which posts a story can be built from', () => {
  /** A term no other suite's fixtures carry, so only these rows can match. */
  const TERM = 'storymembershipcollapsegate';
  const AUTHOR = 'story-membership-collapse-author';
  const seededPosts: string[] = [];
  const seededTrends: string[] = [];

  beforeAll(async () => {
    await connectPostgres();
  });

  afterEach(async () => {
    const trendIds = seededTrends.splice(0);
    if (trendIds.length > 0) await getDb().delete(trending).where(inArray(trending.id, trendIds));
    const postIds = seededPosts.splice(0);
    if (postIds.length > 0) await getDb().delete(posts).where(inArray(posts.id, postIds));
  });

  afterAll(async () => {
    await closePostgres();
  });

  /** Straight into `posts`, as the sibling trending suites seed — the story read
   * is a scan over classified columns, not over the post's content graph. */
  async function variant(): Promise<string> {
    const [row] = await getDb()
      .insert(posts)
      .values({
        oxyUserId: AUTHOR,
        status: 'published',
        visibility: 'public',
        classificationTrendTerms: [TERM],
      })
      .returning({ id: posts.id });
    seededPosts.push(row.id);
    return row.id;
  }

  it('counts one cross-post once while keeping both source posts stored', async () => {
    const shown = await variant();
    const hidden = await variant();
    await createCluster('declared', [
      { postId: shown, networkDomain: 'instagram.com', preferred: true, evidence: 'declared original' },
      { postId: hidden, networkDomain: 'threads.net', preferred: false, evidence: 'declared crosspost' },
    ]);

    const calculatedAt = new Date();
    const [trend] = await getDb()
      .insert(trending)
      .values({ type: 'entity', name: TERM, terms: [TERM], score: 1, rank: 0, calculatedAt })
      .returning({ id: trending.id });
    seededTrends.push(trend.id);

    expect(await saveStoryMemberships([
      { id: trend.id, name: TERM, terms: [TERM], calculatedAt },
    ])).toBe(1);

    const members = await getDb()
      .select({ postId: trendStoryPosts.postId })
      .from(trendStoryPosts)
      .where(eq(trendStoryPosts.trendId, trend.id));
    expect([...members].map((row) => row.postId)).toEqual([shown]);

    // The collapsed variant is hidden from the story, never deleted: `#990`
    // requires both source objects to stay stored and addressable.
    const stored = await getDb().select({ id: posts.id }).from(posts).where(inArray(posts.id, [shown, hidden]));
    expect([...stored]).toHaveLength(2);
  });
});
