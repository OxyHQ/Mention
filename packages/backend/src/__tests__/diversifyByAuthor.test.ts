import { describe, it, expect } from 'vitest';
import type { FeedPostSlice, HydratedPost } from '@mention/shared-types';
import { MtnConfig } from '@mention/shared-types';
import { diversifyByAuthor } from '../mtn/feed/diversifyByAuthor';
import { sliceAuthorKey, sliceCursorAnchor } from '../mtn/feed/rankedCandidate';

interface Item {
  id: string;
  author: string | undefined;
}

const authorOf = (item: Item): string | undefined => item.author;

/**
 * The largest run of consecutive same-author items in a list (ignoring
 * items with no author, which never cluster).
 */
function maxConsecutiveSameAuthor(items: Item[]): number {
  let max = 0;
  let run = 0;
  let prev: string | undefined;
  for (const item of items) {
    if (item.author && item.author === prev) {
      run += 1;
    } else {
      run = 1;
      prev = item.author;
    }
    if (item.author) max = Math.max(max, run);
  }
  return max;
}

/** The smallest gap (in positions) between two items of the SAME author. */
function minGapBetweenSameAuthor(items: Item[]): number {
  const lastSeen = new Map<string, number>();
  let minGap = Infinity;
  items.forEach((item, idx) => {
    if (!item.author) return;
    const prev = lastSeen.get(item.author);
    if (prev !== undefined) {
      minGap = Math.min(minGap, idx - prev - 1);
    }
    lastSeen.set(item.author, idx);
  });
  return minGap;
}

function countByAuthor(items: Item[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.author) continue;
    counts.set(item.author, (counts.get(item.author) ?? 0) + 1);
  }
  return counts;
}

describe('diversifyByAuthor (generic reranker)', () => {
  it('breaks up a dominating author: no consecutive same-author items and min-gap respected', () => {
    // A ranked candidate set where author "A" would dominate the top of the page
    // (5 consecutive) — exactly the "2 users, then 5 in a row from one user"
    // complaint — with a healthy pool of other authors below (enough to space A
    // at the configured gap, which a real candidate set provides).
    const ranked: Item[] = [
      { id: 'a1', author: 'A' },
      { id: 'a2', author: 'A' },
      { id: 'a3', author: 'A' },
      { id: 'a4', author: 'A' },
      { id: 'a5', author: 'A' },
      { id: 'b1', author: 'B' },
      { id: 'c1', author: 'C' },
      { id: 'd1', author: 'D' },
      { id: 'e1', author: 'E' },
      { id: 'f1', author: 'F' },
      { id: 'g1', author: 'G' },
      { id: 'h1', author: 'H' },
      { id: 'i1', author: 'I' },
      { id: 'j1', author: 'J' },
      { id: 'k1', author: 'K' },
    ];

    // Generous cap so this test isolates the GAP behavior (cap tested separately).
    const out = diversifyByAuthor(ranked, authorOf, { minGap: 2, maxPerAuthor: 99 });

    // No items dropped; same multiset of ids.
    expect(out).toHaveLength(ranked.length);
    expect(new Set(out.map((i) => i.id))).toEqual(new Set(ranked.map((i) => i.id)));

    // No two consecutive items by the same author.
    expect(maxConsecutiveSameAuthor(out)).toBe(1);

    // At least `minGap` (2) OTHER items between two items of the same author,
    // for every author that has multiple items spaced within the page.
    expect(minGapBetweenSameAuthor(out)).toBeGreaterThanOrEqual(2);

    // The top item by rank still leads (highest-rank eligible item is always
    // preferred), so diversity does not throw away the ranking signal.
    expect(out[0]?.id).toBe('a1');
  });

  it('minimizes clustering even when there are too few other authors to fully space', () => {
    // 5×A but only 2 other authors: it is mathematically impossible to keep A
    // fully spaced, but the reranker must still do FAR better than the raw input
    // (which had a run of 5) — it should never reproduce the original cluster.
    const ranked: Item[] = [
      { id: 'a1', author: 'A' },
      { id: 'a2', author: 'A' },
      { id: 'a3', author: 'A' },
      { id: 'a4', author: 'A' },
      { id: 'a5', author: 'A' },
      { id: 'b1', author: 'B' },
      { id: 'c1', author: 'C' },
    ];
    const out = diversifyByAuthor(ranked, authorOf, { minGap: 2, maxPerAuthor: 99 });

    expect(out).toHaveLength(ranked.length);
    // Original max run was 5; the reranked stream must be markedly less
    // clustered. Perfect spacing is impossible with only 2 fillers for 5 A's, so
    // we assert a STRICT improvement rather than a fixed bound — the reranker
    // front-loads the diversity it can achieve and pushes the unavoidable
    // remainder to the tail instead of leaving a mid-stream wall of one author.
    expect(maxConsecutiveSameAuthor(out)).toBeLessThan(maxConsecutiveSameAuthor(ranked));
    // The two distinct other authors are both lifted out of the tail cluster so
    // the head of the page is varied (the part the user actually sees first).
    expect(new Set(out.slice(0, 4).map((i) => i.author)).size).toBeGreaterThanOrEqual(3);
  });

  it('enforces the per-author cap by deferring overflow to the tail (never dropping)', () => {
    const ranked: Item[] = Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, author: 'A' }))
      .concat([
        { id: 'b1', author: 'B' },
        { id: 'b2', author: 'B' },
        { id: 'c1', author: 'C' },
      ]);

    const out = diversifyByAuthor(ranked, authorOf, { minGap: 1, maxPerAuthor: 3 });

    // Nothing dropped.
    expect(out).toHaveLength(ranked.length);
    expect(new Set(out.map((i) => i.id))).toEqual(new Set(ranked.map((i) => i.id)));

    // Author A had 8 items but the page cap is 3: the first 3 emit within the
    // body (spaced), the rest are pushed to the tail. The cap bounds in-body
    // emissions, not the total (we never drop), so the overall list still has 8
    // A items but they are all clustered at the end after the capped run.
    const counts = countByAuthor(out);
    expect(counts.get('A')).toBe(8);

    // The first time A appears, it must be spaced (no back-to-back) until the cap
    // is hit; after the cap, overflow sits at the very tail in rank order.
    const tail = out.slice(-5).map((i) => i.author);
    expect(tail.every((a) => a === 'A')).toBe(true);
  });

  it('does not starve: a single remaining author still emits every item', () => {
    const ranked: Item[] = [
      { id: 'a1', author: 'A' },
      { id: 'a2', author: 'A' },
      { id: 'a3', author: 'A' },
    ];
    const out = diversifyByAuthor(ranked, authorOf, { minGap: 2, maxPerAuthor: 99 });
    expect(out.map((i) => i.id).sort()).toEqual(['a1', 'a2', 'a3']);
  });

  it('treats items without an author as conflict-free and preserves them', () => {
    // Two A items with enough authorless filler available to space them — the
    // authorless items never block (no author to cluster) and are all preserved.
    const ranked: Item[] = [
      { id: 'a1', author: 'A' },
      { id: 'a2', author: 'A' },
      { id: 'x1', author: undefined },
      { id: 'x2', author: undefined },
      { id: 'x3', author: undefined },
    ];
    const out = diversifyByAuthor(ranked, authorOf, { minGap: 2, maxPerAuthor: 99 });
    expect(out).toHaveLength(5);
    expect(new Set(out.map((i) => i.id))).toEqual(new Set(['a1', 'x1', 'x2', 'x3', 'a2']));
    // The two authored items by A must be spaced (authorless items fill the gap).
    expect(maxConsecutiveSameAuthor(out)).toBe(1);
  });

  it('uses the shared config knobs by default', () => {
    expect(MtnConfig.ranking.diversity.authorMinGap).toBeGreaterThanOrEqual(1);
    expect(MtnConfig.ranking.diversity.maxPerAuthorPerPage).toBeGreaterThanOrEqual(1);

    const ranked: Item[] = [
      { id: 'a1', author: 'A' },
      { id: 'a2', author: 'A' },
      { id: 'b1', author: 'B' },
      { id: 'c1', author: 'C' },
    ];
    // No options → pulls minGap/maxPerAuthor from MtnConfig; A must not be
    // back-to-back given the default gap (>= 1).
    const out = diversifyByAuthor(ranked, authorOf);
    expect(maxConsecutiveSameAuthor(out)).toBe(1);
  });
});

/**
 * Build a hydrated slice. A multi-item slice models a THREAD (one conversation,
 * one author) and must stay intact as a single unit through reranking.
 */
function makeSlice(sliceKey: string, authorId: string, postIds: string[]): FeedPostSlice {
  return {
    _sliceKey: sliceKey,
    isIncompleteThread: false,
    items: postIds.map((postId, idx) => ({
      post: { id: postId, user: { id: authorId } } as HydratedPost,
      isThreadParent: postIds.length > 1 && idx === 0,
      isThreadChild: postIds.length > 1 && idx > 0,
      isThreadLastChild: postIds.length > 1 && idx === postIds.length - 1,
    })),
  };
}

describe('diversifyByAuthor (slice-level, keyed by primary author)', () => {
  it('spaces same-author slices while keeping a thread intact as one unit', () => {
    // Author A: a single-post slice, a 3-post THREAD, and another single-post
    // slice — all clustered at the top by score. Plus slices from B and C.
    const slices: FeedPostSlice[] = [
      makeSlice('a-single-1', 'A', ['a1']),
      makeSlice('a-thread', 'A', ['a2', 'a3', 'a4']), // thread (3 posts, 1 unit)
      makeSlice('a-single-2', 'A', ['a5']),
      makeSlice('b-single', 'B', ['b1']),
      makeSlice('c-single', 'C', ['c1']),
    ];

    const out = diversifyByAuthor(slices, sliceAuthorKey, { minGap: 1, maxPerAuthor: 99 });

    // Same set of slices, none dropped.
    expect(out).toHaveLength(slices.length);
    expect(new Set(out.map((s) => s._sliceKey))).toEqual(
      new Set(['a-single-1', 'a-thread', 'a-single-2', 'b-single', 'c-single']),
    );

    // The thread slice survives as a single contiguous 3-post unit (intact,
    // in original within-thread order — never split across the page).
    const threadSlice = out.find((s) => s._sliceKey === 'a-thread');
    expect(threadSlice?.items.map((it) => it.post.id)).toEqual(['a2', 'a3', 'a4']);

    // No two consecutive slices share the same primary author.
    const primaryAuthors = out.map((s) => sliceAuthorKey(s));
    for (let i = 1; i < primaryAuthors.length; i += 1) {
      expect(primaryAuthors[i]).not.toBe(primaryAuthors[i - 1]);
    }
  });
});

/**
 * Build a RAW (pre-hydration) slice as the feeds produce it: a single lean post
 * doc carrying `oxyUserId` + `finalScore` + `_id`. The diversity rerank and the
 * cursor watermark run on these BEFORE hydration.
 */
function makeRawSlice(authorId: string, postId: string, finalScore: number): FeedPostSlice {
  return {
    _sliceKey: postId,
    isIncompleteThread: false,
    items: [
      {
        // Mirrors a lean Mongo doc decorated by FeedRankingService.
        post: { _id: { toString: () => postId }, id: postId, oxyUserId: authorId, finalScore } as unknown as HydratedPost,
        isThreadParent: false,
        isThreadChild: false,
        isThreadLastChild: false,
      },
    ],
  };
}

describe('diversify BEFORE truncate (the real feed application: pool → diversify → page)', () => {
  it('a prolific author cannot cluster the page tail: ≤ cap, spaced, backfilled by others', () => {
    const minGap = MtnConfig.ranking.diversity.authorMinGap;
    const cap = MtnConfig.ranking.diversity.maxPerAuthorPerPage;
    const limit = 10;

    // A candidate POOL of ~30 raw slices: author X owns 10 of the top spots
    // (highest scores) — exactly the "5+ in a row from one user" producer — with
    // 20 single-slice authors filling the rest of the pool at lower scores.
    const pool: FeedPostSlice[] = [];
    let score = 1000;
    for (let i = 0; i < 10; i += 1) {
      pool.push(makeRawSlice('X', `x${i}`, score));
      score -= 1;
    }
    for (let i = 0; i < 20; i += 1) {
      pool.push(makeRawSlice(`U${i}`, `u${i}`, score));
      score -= 1;
    }

    // Real feed flow: diversify the WHOLE pool, THEN take the first `limit`.
    const diversified = diversifyByAuthor(pool, sliceAuthorKey);
    const page = diversified.slice(0, limit);

    expect(page).toHaveLength(limit);

    // X contributes at most the per-author cap to the PAGE (excess fell past the
    // page boundary — it is NOT dumped at the tail).
    const xOnPage = page.filter((s) => sliceAuthorKey(s) === 'X').length;
    expect(xOnPage).toBeLessThanOrEqual(cap);

    // No two X slices within the min-gap, anywhere on the page.
    const xPositions = page
      .map((s, idx) => (sliceAuthorKey(s) === 'X' ? idx : -1))
      .filter((idx) => idx >= 0);
    for (let i = 1; i < xPositions.length; i += 1) {
      expect(xPositions[i] - xPositions[i - 1] - 1).toBeGreaterThanOrEqual(minGap);
    }

    // The PAGE TAIL is not an X cluster (the exact reported bug). The last `cap+1`
    // slices must include at least one non-X author.
    const tail = page.slice(-(cap + 1)).map((s) => sliceAuthorKey(s));
    expect(tail.some((a) => a !== 'X')).toBe(true);

    // Variety: other authors backfilled the page from the pool.
    const distinctAuthors = new Set(page.map((s) => sliceAuthorKey(s)));
    expect(distinctAuthors.size).toBeGreaterThan(cap);

    // Cursor watermark = MIN finalScore among the emitted page slices, and it is
    // a real ranked score (never collapses to 0).
    let minScore = Infinity;
    for (const s of page) {
      const anchor = sliceCursorAnchor(s);
      expect(anchor).toBeDefined();
      if (anchor && anchor.score < minScore) minScore = anchor.score;
    }
    expect(minScore).toBeGreaterThan(0);
    expect(minScore).toBeLessThan(Infinity);
  });

  it('sliceCursorAnchor ignores a reply-context parent (no finalScore) and uses the ranked post', () => {
    // A ForYou reply-context slice: items = [parent (fetched separately, NO
    // finalScore), rankedPost (the actual feed post, WITH finalScore)].
    const slice: FeedPostSlice = {
      _sliceKey: 'parent+ranked',
      isIncompleteThread: true,
      items: [
        {
          post: { _id: { toString: () => 'parent' }, id: 'parent', oxyUserId: 'P' } as unknown as HydratedPost,
          isThreadParent: true,
          isThreadChild: false,
          isThreadLastChild: false,
        },
        {
          post: { _id: { toString: () => 'ranked' }, id: 'ranked', oxyUserId: 'R', finalScore: 42 } as unknown as HydratedPost,
          isThreadParent: false,
          isThreadChild: true,
          isThreadLastChild: true,
        },
      ],
    };

    const anchor = sliceCursorAnchor(slice);
    // Must pick the ranked post (score 42, id 'ranked'), NOT the score-less parent
    // (which would collapse the watermark to 0 and break pagination).
    expect(anchor).toEqual({ score: 42, id: 'ranked' });
  });
});
