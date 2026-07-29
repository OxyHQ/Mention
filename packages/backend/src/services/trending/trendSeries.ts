/**
 * Trending VOLUME SERIES — turning stored batches into the sparkline's geometry.
 *
 * This module exists because the chart it feeds was once a lie. The row used to
 * end in a 50×24 "sparkline" whose geometry was three hardcoded polylines picked
 * by the trend's direction, so every rising trend drew the same curve regardless
 * of its numbers. The replacement may only ever draw measurements, which puts two
 * hard rules on everything below:
 *
 *  1. NOTHING is synthesized. Downsampling averages real observations into fewer
 *     real observations; it never interpolates a missing batch, never pads a
 *     short series to the target length, and never emits a placeholder line for a
 *     trend with no history.
 *  2. A trend with too little history gets NO series, so the client draws nothing.
 *     The floor lives in `MtnConfig.trending.series.minPoints` and is applied HERE
 *     — the server is the single authority on it, so no client can decide to draw
 *     a two-point line.
 *
 * Pure and synchronous, with no Mongoose or Express import, so it is unit-testable
 * without the app — the same reason `trendTelemetry.ts` sits outside its route.
 */

import { MtnConfig } from '@mention/shared-types';

const SERIES_CONFIG = MtnConfig.trending.series;

/**
 * Average a bucket of observations. Bucket boundaries are computed by the caller
 * and are always non-empty, so there is no empty-input case to invent a value for.
 */
function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * Reduce an ordered run of observations to at most `maxPoints`, by splitting it
 * into that many contiguous buckets and averaging each.
 *
 * Buckets are cut on INDEX, not on the clock: bucket `i` spans
 * `[⌊i·L/N⌋, ⌊(i+1)·L/N⌋)`, which distributes the remainder evenly rather than
 * leaving a stub bucket at the end. A run shorter than `maxPoints` is returned
 * unchanged — padding it would be inventing points, which is the whole thing this
 * module exists to prevent.
 *
 * Averaging (rather than picking every k-th sample) is what makes the reduction
 * honest at this size: a trend observed 52 times collapses to 12 points that each
 * summarise ~4 real ones, so a spike inside a bucket still lifts the line instead
 * of being dropped because it landed between two sampled indices.
 *
 * Values are rounded to one decimal — `volume` is a post count, so a bucket mean
 * is at most one useful decimal, and trimming the rest keeps the JSON small.
 */
export function downsampleSeries(
  volumes: readonly number[],
  maxPoints: number = SERIES_CONFIG.maxPoints,
): number[] {
  if (volumes.length <= maxPoints) return [...volumes];

  const points: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor((i * volumes.length) / maxPoints);
    const end = Math.floor(((i + 1) * volumes.length) / maxPoints);
    points.push(Math.round(mean(volumes.slice(start, end)) * 10) / 10);
  }
  return points;
}

/**
 * The wire series for one trend, or `undefined` when it has too little history.
 *
 * `undefined` is the honest answer and the client renders no chart for it: a
 * brand-new trend, or one that dipped out of the window and came back, genuinely
 * has nothing to draw. It is never replaced by a flat line — that would be the
 * old invented geometry again, only quieter.
 */
export function buildTrendSeries(
  volumes: readonly number[],
  config: { maxPoints: number; minPoints: number } = SERIES_CONFIG,
): number[] | undefined {
  if (volumes.length < config.minPoints) return undefined;
  return downsampleSeries(volumes, config.maxPoints);
}
