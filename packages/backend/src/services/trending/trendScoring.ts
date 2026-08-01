/**
 * Trend scoring — deciding which terms are actually bursting.
 *
 * Pure: no DB, no network, no clock of its own (every function that needs
 * "now" is handed it). The batch does the counting; this decides what the
 * counts mean.
 *
 * ## Why a burst and not a total
 *
 * The previous scoring was `volume × (1 + momentum/2)`, which is a size
 * ranking wearing a momentum hat: a permanently-popular hashtag has enormous
 * volume every single batch, so it won every single batch. The list was
 * therefore a list of what this instance is always about, which is a fact a
 * reader learns once and never needs again.
 *
 * What a trend actually claims is that something is happening NOW. So a term is
 * measured against ITSELF: given how much it was posted over the trailing
 * window, how much would you expect in the recent window, and how far above
 * that did it land? A steady term predicts itself and scores ~0 no matter how
 * large it is; a term that barely existed yesterday and is everywhere this
 * afternoon scores high no matter how small. That single change is what stops
 * the list being a hashtag leaderboard.
 *
 * The statistic is the standardized residual of a Poisson count — the natural
 * model for "independent events arriving at some rate", which is what posts
 * mentioning a term are. Its unit is standard deviations, so the thresholds in
 * `MtnConfig.trending.detection` mean the same thing on a quiet instance and a
 * loud one, and they do not need retuning as the network grows.
 */

import { MtnConfig } from '@mention/shared-types';
import type { TrendStatus } from '@mention/shared-types';

/** What the batch measured for one term. */
export interface TrendCandidate {
  /** The term itself (lowercase; may be a phrase). */
  term: string;
  /** Posts carrying the term in the trailing window. */
  volume: number;
  /** Posts carrying it in the recent window (a subset of {@link volume}). */
  recentVolume: number;
  /** DISTINCT authors behind those posts — the floor is on people, not posts. */
  authorCount: number;
}

/** A candidate that cleared the floors, with everything the row needs. */
export interface ScoredTrend extends TrendCandidate {
  /**
   * How far the recent count sits above what the trailing rate predicts, in
   * standard deviations. This is the measurement; `score` only orders it.
   */
  burstScore: number;
  /** Ranking score — {@link burstScore} with a mild size preference applied. */
  score: number;
  /**
   * Share of the term's window that landed in the recent window, normalized so
   * `1` means "entirely recent" — the existing 0..1 momentum contract the
   * client's direction arrow reads. Unchanged on purpose: the arrow answers
   * "rising or falling", which is a different (and still correct) question from
   * the one `burstScore` answers.
   */
  momentum: number;
  /** Present only for a trend bursting hard enough to be called out. */
  status?: TrendStatus;
}

/**
 * Score one candidate, or return `null` when it does not clear the floors.
 *
 * The three floors are independent and each rules out a different failure:
 * `minVolume` rules out a rate estimated from too few observations to mean
 * anything, `minAuthors` rules out one account posting fifty times, and
 * `minBurstScore` rules out ordinary fluctuation of an ordinary term.
 */
export function scoreTrendCandidate(candidate: TrendCandidate): ScoredTrend | null {
  const { windowMs, recentWindowMs, minVolume, minAuthors, minBurstScore, hotBurstScore } =
    MtnConfig.trending.detection;

  if (candidate.volume < minVolume) return null;
  if (candidate.authorCount < minAuthors) return null;

  // What the trailing rate predicts for the recent window, if the term were
  // arriving uniformly. `volume` includes `recentVolume`, so this is the term's
  // own average — never a global or cross-term baseline, which would just
  // rediscover that some subjects are more popular than others.
  const expected = candidate.volume * (recentWindowMs / windowMs);
  if (expected <= 0) return null;

  // Poisson: variance equals the mean, so the standard deviation is its root.
  const burstScore = (candidate.recentVolume - expected) / Math.sqrt(expected);
  if (burstScore < minBurstScore) return null;

  return {
    ...candidate,
    burstScore,
    score: burstScore * sizePreference(candidate.volume),
    momentum: Math.min(candidate.recentVolume / expected, 1),
    ...(burstScore >= hotBurstScore ? { status: 'hot' as const } : {}),
  };
}

/**
 * Score every candidate and return the survivors, best first, capped at
 * `MtnConfig.trending.detection.maxTrends`.
 *
 * Ties break on `volume` and then on the term itself, so a batch is a pure
 * function of what it measured — two terms with identical statistics must not
 * swap places between batches on Mongo's document order, which would make a
 * trend's rank jitter for no reason a reader could perceive.
 */
export function rankTrendCandidates(candidates: readonly TrendCandidate[]): ScoredTrend[] {
  const scored: ScoredTrend[] = [];
  for (const candidate of candidates) {
    const trend = scoreTrendCandidate(candidate);
    if (trend) scored.push(trend);
  }

  scored.sort(
    (a, b) => b.score - a.score || b.volume - a.volume || a.term.localeCompare(b.term),
  );
  return scored.slice(0, MtnConfig.trending.detection.maxTrends);
}

/**
 * A MILD preference for the larger of two equally-anomalous terms.
 *
 * Logarithmic and deliberately weak: over the whole plausible range of volumes
 * it spans about a factor of three, so it can order two similar bursts but can
 * never let a big steady term outrank a real one — which is the failure the
 * burst statistic exists to prevent, and would be silly to reintroduce here.
 */
function sizePreference(volume: number): number {
  return Math.log10(10 + volume);
}

/**
 * When the current run of a trend began.
 *
 * `appearances` is every batch timestamp the term was reported in, ascending;
 * `now` is the batch being computed. The answer is the start of the UNBROKEN
 * run ending at the present batch, where "unbroken" tolerates
 * `onsetGapToleranceMs`.
 *
 * The tolerance is the whole subtlety. Trends hover around the reporting
 * threshold, so a live one routinely drops out of a batch or two and returns.
 * Treating each of those dips as a new start would reset a day-old story's age
 * to zero and relight its `new` badge — repeatedly, for as long as it stays
 * interesting. Reconstructing the run from stored history rather than keeping a
 * per-term "still running" flag also means the answer survives a task restart
 * and needs no state of its own to go stale.
 */
export function resolveTrendStartedAt(appearances: readonly Date[], now: Date): Date {
  const { onsetGapToleranceMs } = MtnConfig.trending.detection;

  const ascending = [...appearances].sort((a, b) => a.getTime() - b.getTime());

  let runStart = now;
  let previous = now.getTime();
  for (let index = ascending.length - 1; index >= 0; index--) {
    const appearance = ascending[index];
    const at = appearance.getTime();
    // A future/duplicate timestamp cannot extend the run backwards; skip it
    // rather than letting it reset `previous` forward.
    if (at > previous) continue;
    if (previous - at > onsetGapToleranceMs) break;
    runStart = appearance;
    previous = at;
  }

  return runStart;
}
