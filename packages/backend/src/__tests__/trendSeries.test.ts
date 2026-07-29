import { describe, it, expect } from 'vitest';
import { MtnConfig } from '@mention/shared-types';
import { buildTrendSeries, downsampleSeries } from '../services/trending/trendSeries';

const { maxPoints, minPoints } = MtnConfig.trending.series;

/** A run of `length` observations, each distinct, so any dropped or reordered
 *  point is visible in the output rather than hidden by a repeated value. */
function ramp(length: number): number[] {
  return Array.from({ length }, (_, index) => index + 1);
}

describe('downsampleSeries', () => {
  it('averages each index bucket', () => {
    // 6 observations into 3 buckets: [1,2] [3,4] [5,6].
    expect(downsampleSeries([1, 2, 3, 4, 5, 6], 3)).toEqual([1.5, 3.5, 5.5]);
  });

  it('distributes the remainder instead of leaving a stub bucket', () => {
    // 7 into 3 cuts at ⌊7/3⌋=2 and ⌊14/3⌋=4, giving 2 + 2 + 3 — never 3 + 3 + 1.
    expect(downsampleSeries([2, 4, 6, 8, 10, 20, 30], 3)).toEqual([3, 7, 20]);
  });

  it('keeps a spike inside a bucket visible', () => {
    // Picking every k-th sample would drop the 100 entirely; averaging lifts the
    // bucket that contains it, which is the point of averaging over sampling.
    const [first, second] = downsampleSeries([1, 1, 1, 100], 2);
    expect(first).toBe(1);
    expect(second).toBeGreaterThan(first);
  });

  it('returns a run shorter than the target unchanged — never padded', () => {
    expect(downsampleSeries([4, 5, 6], maxPoints)).toEqual([4, 5, 6]);
    expect(downsampleSeries(ramp(maxPoints), maxPoints)).toEqual(ramp(maxPoints));
  });

  it('never emits more points than it was given', () => {
    for (const length of [1, 2, 5, 13, 48, 52, 300]) {
      expect(downsampleSeries(ramp(length), maxPoints).length).toBeLessThanOrEqual(
        Math.min(length, maxPoints),
      );
    }
  });

  it('preserves time order', () => {
    const points = downsampleSeries(ramp(52), maxPoints);
    expect(points).toHaveLength(maxPoints);
    expect([...points].sort((a, b) => a - b)).toEqual(points);
  });

  it('rounds bucket means to one decimal', () => {
    // Mean of [1,2,2] is 1.666…; anything longer than one decimal is noise on a
    // post count and only costs JSON bytes.
    expect(downsampleSeries([1, 2, 2], 1)).toEqual([1.7]);
  });

  it('does not mutate its input', () => {
    const volumes = [9, 8, 7, 6];
    downsampleSeries(volumes, 2);
    expect(volumes).toEqual([9, 8, 7, 6]);
  });
});

describe('buildTrendSeries', () => {
  it('omits a series below the coverage floor', () => {
    // A trend nobody has watched long enough draws NOTHING. The absence is the
    // honest answer — the client must never receive a short or padded line.
    for (let length = 0; length < minPoints; length++) {
      expect(buildTrendSeries(ramp(length))).toBeUndefined();
    }
  });

  it('emits exactly the real points at the floor, without padding to maxPoints', () => {
    const series = buildTrendSeries(ramp(minPoints));
    expect(series).toEqual(ramp(minPoints));
    expect(series).toHaveLength(minPoints);
    expect(minPoints).toBeLessThan(maxPoints);
  });

  it('caps a full day of batches at maxPoints', () => {
    // 48 batches is a 24-hour window at the 30-minute cadence; prod carries a few
    // more when the job restarts, and the wire size must not move with it.
    expect(buildTrendSeries(ramp(48))).toHaveLength(maxPoints);
    expect(buildTrendSeries(ramp(52))).toHaveLength(maxPoints);
  });

  it('draws a genuinely constant series rather than suppressing it', () => {
    // A trend whose volume held steady all day is a measurement, not missing
    // data; the row renders it as a flat line.
    expect(buildTrendSeries(Array(minPoints).fill(7))).toEqual(Array(minPoints).fill(7));
  });

  it('honours an explicit floor and cap', () => {
    expect(buildTrendSeries(ramp(3), { minPoints: 4, maxPoints: 12 })).toBeUndefined();
    expect(buildTrendSeries(ramp(4), { minPoints: 4, maxPoints: 12 })).toEqual([1, 2, 3, 4]);
    expect(buildTrendSeries(ramp(20), { minPoints: 4, maxPoints: 5 })).toHaveLength(5);
  });
});
