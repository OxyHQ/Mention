import { describe, it, expect } from 'vitest';
import { MtnConfig } from '@mention/shared-types';
import {
  rankTrendCandidates,
  resolveTrendStartedAt,
  scoreTrendCandidate,
  type TrendCandidate,
} from '../services/trending/trendScoring';

const { windowMs, recentWindowMs, minAuthors, minVolume, hotBurstScore, onsetGapToleranceMs } =
  MtnConfig.trending.detection;

/** Share of a term's trailing window that the recent window covers (0.25). */
const RECENT_SHARE = recentWindowMs / windowMs;

/**
 * A candidate with a steady arrival rate: exactly the share of its volume that
 * a uniform rate predicts landed in the recent window. This is the shape of a
 * perennial hashtag, and it must never trend however large it is.
 */
function steady(volume: number, term = 'steady'): TrendCandidate {
  return {
    term,
    volume,
    recentVolume: Math.round(volume * RECENT_SHARE),
    authorCount: Math.max(minAuthors, 10),
  };
}

/** A candidate whose entire volume arrived inside the recent window. */
function bursting(volume: number, term = 'burst'): TrendCandidate {
  return { term, volume, recentVolume: volume, authorCount: Math.max(minAuthors, 10) };
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
      scoreTrendCandidate({ term: 'real', volume: 500, recentVolume: 500, authorCount: minAuthors }),
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
