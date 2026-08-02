import { describe, it, expect } from 'vitest';
import { MtnConfig } from '@mention/shared-types';
import {
  clearsFloors,
  rankTrendCandidates,
  resolveTrendStartedAt,
  scoreTrendCandidate,
  topUpWithPopular,
  type TrendCandidate,
} from '../services/trending/trendScoring';

const {
  windowMs,
  recentWindowMs,
  minAuthors,
  minVolume,
  maxDocumentFrequency,
  minTrends,
  minPopularVolume,
  hotBurstScore,
  onsetGapToleranceMs,
} = MtnConfig.trending.detection;

/** Share of a term's trailing window that the recent window covers (0.25). */
const RECENT_SHARE = recentWindowMs / windowMs;

/**
 * A candidate with a steady arrival rate: exactly the share of its volume that
 * a uniform rate predicts landed in the recent window. This is the shape of a
 * perennial hashtag, and it must never trend however large it is.
 */
function steady(volume: number, term = 'steady'): TrendCandidate {
  return { term, volume, recentVolume: Math.round(volume * RECENT_SHARE), authorCount: authorsFor(volume) };
}

/**
 * Enough distinct authors for the fixture to clear the author floor.
 *
 * These fixtures are about the BURST statistic, so they must not be refused for
 * an unrelated reason. There is no longer a concentration ceiling to satisfy:
 * repetition is discounted upstream by `authorPostCap`, so a candidate reaching
 * this function already carries a per-author-capped volume.
 */
function authorsFor(_volume: number): number {
  return minAuthors;
}

/** A candidate whose entire volume arrived inside the recent window. */
function bursting(volume: number, term = 'burst'): TrendCandidate {
  return { term, volume, recentVolume: volume, authorCount: authorsFor(volume) };
}

describe('scoreTrendCandidate — the burst, not the size', () => {
  it('refuses a steady term however large it is', () => {
    expect(scoreTrendCandidate(steady(50))).toBeNull();
    expect(scoreTrendCandidate(steady(5_000))).toBeNull();
    expect(scoreTrendCandidate(steady(500_000))).toBeNull();
  });

  it('accepts a small term whose volume all arrived recently', () => {
    expect(scoreTrendCandidate(bursting(12))).not.toBeNull();
  });

  it('ranks a small burst above a huge steady term', () => {
    const ranked = rankTrendCandidates([steady(100_000, 'photography'), bursting(12, 'kremer')]);
    expect(ranked.map((trend) => trend.term)).toEqual(['kremer']);
  });

  it('scores a bigger burst above a smaller equally-anomalous one', () => {
    const ranked = rankTrendCandidates([bursting(12, 'small'), bursting(400, 'big')]);
    expect(ranked[0].term).toBe('big');
  });
});

describe('scoreTrendCandidate — floors', () => {
  it('refuses a term below the volume floor', () => {
    expect(scoreTrendCandidate(bursting(minVolume - 1, 'tiny'))).toBeNull();
  });

  it('refuses a burst carried by too few distinct authors', () => {
    expect(
      scoreTrendCandidate({ term: 'brigade', volume: 500, recentVolume: 500, authorCount: minAuthors - 1 }),
    ).toBeNull();
  });

  it('accepts the same burst once enough distinct authors carry it', () => {
    expect(
      scoreTrendCandidate({ term: 'real', volume: 500, recentVolume: 500, authorCount: authorsFor(500) }),
    ).not.toBeNull();
  });

  it('refuses a term with no volume at all', () => {
    expect(scoreTrendCandidate({ term: 'none', volume: 0, recentVolume: 0, authorCount: 99 })).toBeNull();
  });
});

describe('scoreTrendCandidate — status and momentum', () => {
  it('marks a hard burst hot', () => {
    const trend = scoreTrendCandidate(bursting(500, 'hot'));
    expect(trend?.burstScore).toBeGreaterThanOrEqual(hotBurstScore);
    expect(trend?.status).toBe('hot');
  });

  it('leaves a mild burst without a status', () => {
    // Just above the reporting floor: real, but not a claim that it is hot.
    const trend = scoreTrendCandidate({ term: 'mild', volume: 40, recentVolume: 16, authorCount: 10 });
    expect(trend).not.toBeNull();
    expect(trend?.burstScore).toBeLessThan(hotBurstScore);
    expect(trend?.status).toBeUndefined();
  });

  it('keeps momentum inside the 0..1 contract the client reads', () => {
    for (const candidate of [bursting(500), { term: 'x', volume: 40, recentVolume: 16, authorCount: 10 }]) {
      const trend = scoreTrendCandidate(candidate);
      expect(trend?.momentum).toBeGreaterThanOrEqual(0);
      expect(trend?.momentum).toBeLessThanOrEqual(1);
    }
  });
});

describe('rankTrendCandidates', () => {
  it('caps the batch at the configured maximum', () => {
    const many = Array.from({ length: MtnConfig.trending.detection.maxTrends + 20 }, (_, index) =>
      bursting(50 + index, `term${index}`),
    );
    expect(rankTrendCandidates(many)).toHaveLength(MtnConfig.trending.detection.maxTrends);
  });

  it('is a pure function of the measurements — identical inputs tie deterministically', () => {
    const a = rankTrendCandidates([bursting(50, 'beta'), bursting(50, 'alpha')]);
    const b = rankTrendCandidates([bursting(50, 'alpha'), bursting(50, 'beta')]);
    expect(a.map((trend) => trend.term)).toEqual(b.map((trend) => trend.term));
  });

  it('drops every candidate when none bursts', () => {
    expect(rankTrendCandidates([steady(1_000, 'a'), steady(2_000, 'b')])).toEqual([]);
  });
});

describe('resolveTrendStartedAt', () => {
  const now = new Date('2026-08-01T12:00:00Z');
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

  it('returns now for a term with no history', () => {
    expect(resolveTrendStartedAt([], now)).toEqual(now);
  });

  it('walks an unbroken run back to its first batch', () => {
    const appearances = [minutesAgo(90), minutesAgo(60), minutesAgo(30)];
    expect(resolveTrendStartedAt(appearances, now)).toEqual(minutesAgo(90));
  });

  it('tolerates a dip shorter than the gap tolerance', () => {
    const toleratedGap = onsetGapToleranceMs / 60_000 - 1;
    const appearances = [minutesAgo(toleratedGap + 30), minutesAgo(30)];
    expect(resolveTrendStartedAt(appearances, now)).toEqual(minutesAgo(toleratedGap + 30));
  });

  it('starts a new run after a gap longer than the tolerance', () => {
    const brokenGap = onsetGapToleranceMs / 60_000 + 30;
    const appearances = [minutesAgo(brokenGap + 30), minutesAgo(30)];
    expect(resolveTrendStartedAt(appearances, now)).toEqual(minutesAgo(30));
  });

  it('returns now when the term has been absent longer than the tolerance', () => {
    expect(resolveTrendStartedAt([minutesAgo(onsetGapToleranceMs / 60_000 + 30)], now)).toEqual(now);
  });

  it('does not care what order the history arrives in', () => {
    const ascending = [minutesAgo(90), minutesAgo(60), minutesAgo(30)];
    const shuffled = [minutesAgo(30), minutesAgo(90), minutesAgo(60)];
    expect(resolveTrendStartedAt(shuffled, now)).toEqual(resolveTrendStartedAt(ascending, now));
  });
});

describe('clearsFloors — repetition is discounted, not judged', () => {
  /*
   * The same real terms as before, written as the aggregation now hands them
   * over. `authorPostCap` counts each author at most twice, so a candidate's
   * `volume` is already "how widely" — and the cases the old concentration
   * ceiling was written for fail the ordinary floors without needing it.
   */
  it('refuses one account posting a term twenty times', () => {
    // #noticia — 20 posts, all from tierrasapiens@mastodon.social. Capped to 2.
    expect(clearsFloors({ term: 'noticia', volume: 2, recentVolume: 2, authorCount: 1 })).toBe(false);
  });

  it('refuses two accounts alternating all day', () => {
    // #cartoon — 40 posts from simpsonsgifs + futuramagifs. Capped to 4, which
    // clears the volume floor; the AUTHOR floor is what refuses it.
    expect(clearsFloors({ term: 'cartoon', volume: 4, recentVolume: 2, authorCount: 2 })).toBe(false);
  });

  it('accepts the same volume when it comes from many people', () => {
    expect(clearsFloors({ term: 'real', volume: 40, recentVolume: 12, authorCount: 20 })).toBe(true);
  });

  it('accepts a crowd that contains one loud member', () => {
    // `news`, measured 2026-08-03: 37 raw posts from EIGHT distinct authors,
    // one of them a bot with twenty. The old ceiling refused it for averaging
    // 4.6 posts per author — refusing eight people because of one of them.
    // Capped, it is 13.
    expect(clearsFloors({ term: 'news', volume: 13, recentVolume: 4, authorCount: 8 })).toBe(true);
  });

  it('still applies the author and volume floors', () => {
    expect(clearsFloors({ term: 'thin', volume: minVolume - 1, recentVolume: 1, authorCount: 9 })).toBe(false);
    expect(clearsFloors({ term: 'few', volume: 9, recentVolume: 9, authorCount: minAuthors - 1 })).toBe(false);
  });
});

describe('clearsFloors — vocabulary is not a subject', () => {
  /*
   * From the live widget, 2026-08-01: `why`, `will` and `mention` were reported
   * as trends. The first two are function words and the third is this
   * instance's own name; none is a subject, and all three cleared every other
   * floor because a handful of people each said them once.
   *
   * The share-of-corpus ceiling refuses them WITHOUT knowing which words exist,
   * in which language, or how `mention` got into the vocabulary in the first
   * place — a question that is still open.
   */
  it('refuses a term carried by a large share of everything posted', () => {
    expect(clearsFloors({
      term: 'mention', volume: 40, recentVolume: 20, authorCount: 13,
      documentFrequency: maxDocumentFrequency + 0.01,
    })).toBe(false);
  });

  it('accepts the same numbers when the term is rare in the corpus', () => {
    expect(clearsFloors({
      term: 'kremer', volume: 40, recentVolume: 20, authorCount: 13,
      documentFrequency: maxDocumentFrequency / 10,
    })).toBe(true);
  });

  it('passes a candidate whose frequency was never measured', () => {
    // Absent must mean "not measured", never "delete the term".
    expect(clearsFloors({ term: 'x', volume: 12, recentVolume: 6, authorCount: 5 })).toBe(true);
  });

  it('keeps the ceiling out of the way of a genuinely huge story', () => {
    // A real story is enormous in absolute terms and still a small share of a
    // day's posting; the ceiling must not be what stops it.
    expect(clearsFloors({
      term: 'fifa', volume: 1_897, recentVolume: 900, authorCount: 800,
      documentFrequency: 0.02,
    })).toBe(true);
  });
});

describe('topUpWithPopular — never blank, never lax', () => {
  const popular = (volume: number, term: string): TrendCandidate => ({
    term,
    volume,
    recentVolume: Math.round(volume * RECENT_SHARE),
    authorCount: authorsFor(volume),
  });

  it('leaves a full list of bursts alone', () => {
    const bursts = Array.from({ length: minTrends }, (_, i) => bursting(50 + i, `burst${i}`));
    const ranked = rankTrendCandidates(bursts);
    expect(topUpWithPopular(bursts, ranked)).toEqual(ranked);
  });

  it('refuses to fill the list with terms too small to be called popular', () => {
    // Live batch: `came` reached the widget with 3 posts and a negative burst
    // score. Not spiking and not popular is not a trend by either definition.
    expect(topUpWithPopular([popular(minPopularVolume - 1, 'came')], [])).toEqual([]);
  });

  it('fills an empty list from the most-posted terms', () => {
    // Each clears `minPopularVolume` — the popular path's own, higher bar.
    const candidates = [popular(30, 'a'), popular(20, 'b'), popular(15, 'c')];
    const filled = topUpWithPopular(candidates, []);
    expect(filled.map((t) => t.term)).toEqual(['a', 'b', 'c']);
  });

  it('keeps bursts above topped-up rows, however much bigger those are', () => {
    const burst = bursting(12, 'spiking');
    const candidates = [burst, popular(5_000, 'huge')];
    const filled = topUpWithPopular(candidates, rankTrendCandidates([burst]));
    expect(filled[0].term).toBe('spiking');
    expect(filled[1].term).toBe('huge');
  });

  it('never claims a topped-up row is hot or bursting', () => {
    const filled = topUpWithPopular([popular(500, 'steady')], []);
    expect(filled[0].status).toBeUndefined();
    expect(filled[0].burstScore).toBeLessThan(MtnConfig.trending.detection.minBurstScore);
  });

  it('applies EVERY floor to the rows it adds', () => {
    // The exact shapes the floors exist to refuse must not come back in
    // through the fallback — that would be the old behaviour, restored quietly.
    const filled = topUpWithPopular(
      [
        { term: 'noticia', volume: 20, recentVolume: 5, authorCount: 1 },
        { term: 'cartoon', volume: 40, recentVolume: 12, authorCount: 2 },
      ],
      [],
    );
    expect(filled).toEqual([]);
  });

  it('never duplicates a term already reported as a burst', () => {
    const burst = bursting(12, 'spiking');
    const filled = topUpWithPopular([burst], rankTrendCandidates([burst]));
    expect(filled.filter((t) => t.term === 'spiking')).toHaveLength(1);
  });

  it('stops at minTrends rather than filling to the cap', () => {
    const candidates = Array.from({ length: minTrends + 10 }, (_, i) => popular(100 - i, `t${i}`));
    expect(topUpWithPopular(candidates, [])).toHaveLength(minTrends);
  });
});
