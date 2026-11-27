import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The backfill throttle: the off-peak window and latency backpressure every corpus
 * backfill calls once per batch. A fake clock that only `sleep` and the batches
 * advance stands in for real time, so nothing here waits.
 */

vi.mock('../../queue/queues', () => ({ closeQueues: vi.fn() }));
vi.mock('../../queue/connection', () => ({ closeQueueConnection: vi.fn() }));

import {
  BackfillStoppedError,
  type BackfillThrottleConfig,
  EXIT_BACKFILL_STOPPED,
  backfillExitCode,
  backfillThrottleConfigFromEnv,
  createBackfillThrottle,
  fixedPauseThrottle,
  isInsideBackfillWindow,
  msUntilBackfillWindowOpens,
  parseBackfillWindow,
} from '../../scripts/lib/backfillThrottle';
import { logger } from '../../utils/logger';

const HOUR = 60 * 60 * 1000;
/** 2026-11-28 at `hour`:`minute` UTC. */
const at = (hour: number, minute = 0) => Date.UTC(2026, 10, 28, hour, minute);

function fakeClock(start: number) {
  let time = start;
  const sleeps: number[] = [];
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

const ALWAYS_OPEN: Partial<BackfillThrottleConfig> = { window: { always: true } };

/** A throttle on the fake clock; the env carries only what a test sets. */
function throttleOn(
  clock: ReturnType<typeof fakeClock>,
  config: Partial<BackfillThrottleConfig> = ALWAYS_OPEN,
  env: Record<string, string> = {},
) {
  const recordStop = vi.fn(async () => true);
  const throttle = createBackfillThrottle({
    script: 'testBackfill',
    pauseMs: 100,
    env,
    config: { baselineBatches: 3, ...config },
    now: clock.now,
    sleep: clock.sleep,
    recordStop,
  });
  /** One batch of `ms` milliseconds; returns what the throttle slept before it. */
  const batch = async (ms: number, cursor = 'cursor') => {
    const before = clock.sleeps.length;
    await throttle.beforeBatch({ cursor, scope: 'posts', scanned: 1 });
    clock.advance(ms);
    return clock.sleeps.slice(before);
  };
  return { throttle, batch, recordStop };
}

beforeEach(() => {
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
});

describe('parseBackfillWindow', () => {
  it('defaults to 01-07 UTC', () => {
    expect(parseBackfillWindow(undefined)).toEqual({ always: false, startHour: 1, endHour: 7 });
    expect(parseBackfillWindow('  ')).toEqual({ always: false, startHour: 1, endHour: 7 });
  });

  it('reads HH-HH, a wrap-around and always', () => {
    expect(parseBackfillWindow('22-04')).toEqual({ always: false, startHour: 22, endHour: 4 });
    expect(parseBackfillWindow('0-24')).toEqual({ always: false, startHour: 0, endHour: 24 });
    expect(parseBackfillWindow('ALWAYS')).toEqual({ always: true });
  });

  it('refuses what is not a window', () => {
    for (const bad of ['1-1', '25-03', '01-25', '1:00-7:00', 'night', '-3']) {
      expect(() => parseBackfillWindow(bad)).toThrow(/BACKFILL_WINDOW_UTC/);
    }
  });
});

describe('the window', () => {
  const plain = parseBackfillWindow('01-07');
  const wrapping = parseBackfillWindow('22-04');

  it('is open from the start hour up to, not including, the end hour', () => {
    expect(isInsideBackfillWindow(plain, at(0, 59))).toBe(false);
    expect(isInsideBackfillWindow(plain, at(1))).toBe(true);
    expect(isInsideBackfillWindow(plain, at(6, 59))).toBe(true);
    expect(isInsideBackfillWindow(plain, at(7))).toBe(false);
  });

  it('wraps midnight', () => {
    expect(isInsideBackfillWindow(wrapping, at(23))).toBe(true);
    expect(isInsideBackfillWindow(wrapping, at(3, 59))).toBe(true);
    expect(isInsideBackfillWindow(wrapping, at(4))).toBe(false);
    expect(isInsideBackfillWindow(wrapping, at(12))).toBe(false);
  });

  it('opens next at the start hour, today or tomorrow', () => {
    expect(msUntilBackfillWindowOpens(plain, at(0, 30))).toBe(HOUR / 2);
    expect(msUntilBackfillWindowOpens(plain, at(7))).toBe(18 * HOUR);
    expect(msUntilBackfillWindowOpens(plain, at(3))).toBe(0);
    expect(msUntilBackfillWindowOpens(wrapping, at(4))).toBe(18 * HOUR);
    expect(msUntilBackfillWindowOpens({ always: true }, at(12))).toBe(0);
  });
});

describe('createBackfillThrottle: the window', () => {
  it('waits for the window to open before the first batch, and logs it once', async () => {
    const clock = fakeClock(at(12));
    const { batch } = throttleOn(clock, {});
    expect(await batch(10)).toEqual([13 * HOUR]);
    expect(new Date(clock.now()).getUTCHours()).toBe(1);
    const waits = vi
      .mocked(logger.info)
      .mock.calls.filter(([message]) => String(message).includes('outside the off-peak window'));
    expect(waits).toHaveLength(1);
  });

  it('runs inside the window and sleeps again when it closes', async () => {
    const clock = fakeClock(at(6, 58));
    const { batch } = throttleOn(clock, {});
    expect(await batch(60_000)).toEqual([]); // 06:58, open
    // 06:59:00 + 100 ms pause: still open.
    expect(await batch(60_000)).toEqual([100]);
    // 07:00:00.1: closed until 01:00 tomorrow.
    const slept = await batch(10);
    expect(slept[0]).toBe(100);
    expect(slept[1]).toBe(msUntilBackfillWindowOpens(parseBackfillWindow('01-07'), at(7) + 200));
    expect(new Date(clock.now()).getUTCHours()).toBe(1);
  });

  it('honours a wrap-around window from the environment', async () => {
    const clock = fakeClock(at(21, 30));
    const { batch } = throttleOn(clock, {}, { BACKFILL_WINDOW_UTC: '22-04' });
    expect(await batch(10)).toEqual([HOUR / 2]);
  });

  it('never waits with BACKFILL_WINDOW_UTC=always, and says so loudly', async () => {
    const clock = fakeClock(at(15));
    const { batch } = throttleOn(clock, {}, { BACKFILL_WINDOW_UTC: 'always' });
    expect(await batch(10)).toEqual([]);
    expect(await batch(10)).toEqual([100]);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('OFF-PEAK WINDOW DISABLED'),
      expect.objectContaining({ script: 'testBackfill' }),
    );
  });

  it('refuses a malformed environment before any batch', () => {
    expect(() => backfillThrottleConfigFromEnv({ BACKFILL_WINDOW_UTC: 'soon' }, 0)).toThrow();
    expect(() => backfillThrottleConfigFromEnv({ BACKFILL_SLOW_FACTOR: '0.5' }, 0)).toThrow();
    expect(() => backfillThrottleConfigFromEnv({ BACKFILL_MAX_SLOW_BATCHES: 'x' }, 0)).toThrow();
    expect(
      backfillThrottleConfigFromEnv(
        {
          BACKFILL_SLOW_FACTOR: '3',
          BACKFILL_SLOW_BATCH_MS: '90000',
          BACKFILL_BACKOFF_MAX_MS: '60000',
          BACKFILL_MAX_SLOW_BATCHES: '4',
        },
        250,
      ),
    ).toMatchObject({
      pauseMs: 250,
      slowFactor: 3,
      slowCeilingMs: 90_000,
      backoffMaxMs: 60_000,
      maxConsecutiveSlow: 4,
    });
  });
});

describe('createBackfillThrottle: backpressure', () => {
  it('keeps the normal pause while batches stay near the baseline', async () => {
    const clock = fakeClock(at(2));
    const { batch } = throttleOn(clock);
    await batch(2_000);
    for (let i = 0; i < 6; i += 1) expect(await batch(2_000 + i * 100)).toEqual([100]);
    expect(await batch(3_900)).toEqual([100]);
  });

  it('backs off exponentially on slow batches, capped', async () => {
    const clock = fakeClock(at(2));
    const { batch } = throttleOn(clock, {
      ...ALWAYS_OPEN,
      backoffBaseMs: 15_000,
      backoffMaxMs: 60_000,
      maxConsecutiveSlow: 99,
    });
    for (let i = 0; i < 4; i += 1) await batch(2_000); // baseline 2 s: slow above 4 s
    expect(await batch(5_000)).toEqual([100]);
    expect(await batch(5_000)).toEqual([15_000]);
    expect(await batch(5_000)).toEqual([30_000]);
    expect(await batch(5_000)).toEqual([60_000]);
    expect(await batch(5_000)).toEqual([60_000]);
  });

  it('returns to the normal pace once a batch is fast again', async () => {
    const clock = fakeClock(at(2));
    const { batch } = throttleOn(clock, { ...ALWAYS_OPEN, maxConsecutiveSlow: 99 });
    for (let i = 0; i < 4; i += 1) await batch(2_000);
    await batch(9_000);
    expect(await batch(2_000)).toEqual([15_000]); // the slow one's backoff
    expect(await batch(2_000)).toEqual([100]); // fast: normal pace
    expect(await batch(9_000)).toEqual([100]);
    expect(await batch(2_000)).toEqual([15_000]); // the backoff starts over, not at 30 s
  });

  it('treats a batch over the absolute ceiling as slow before any baseline exists', async () => {
    const clock = fakeClock(at(2));
    const { batch } = throttleOn(clock, { ...ALWAYS_OPEN, slowCeilingMs: 30_000 });
    await batch(31_000);
    expect(await batch(1_000)).toEqual([15_000]);
  });

  it('ignores jitter on fast batches', async () => {
    const clock = fakeClock(at(2));
    const { batch } = throttleOn(clock);
    for (let i = 0; i < 4; i += 1) await batch(20);
    await batch(900);
    expect(await batch(20)).toEqual([100]); // the 900 ms one: 45x the baseline, but under a second
  });

  it('gives up after many slow batches in a row, recording the cursor', async () => {
    const clock = fakeClock(at(2));
    const { batch, recordStop } = throttleOn(clock, { ...ALWAYS_OPEN, maxConsecutiveSlow: 3 });
    for (let i = 0; i < 4; i += 1) await batch(2_000);
    await batch(10_000, 'c1');
    await batch(10_000, 'c2');
    await batch(10_000, 'c3');
    const stopped = batch(1, 'c4');
    await expect(stopped).rejects.toBeInstanceOf(BackfillStoppedError);
    await expect(stopped).rejects.toMatchObject({ cursor: 'c4', exitCode: EXIT_BACKFILL_STOPPED });
    expect(recordStop).toHaveBeenCalledWith('posts', 'c4', 1);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining('stopping'),
      expect.objectContaining({ script: 'testBackfill', scope: 'posts', slowBatches: 3 }),
    );
  });

  it('stops a dry run without writing the cursor', async () => {
    const clock = fakeClock(at(2));
    const recordStop = vi.fn(async () => true);
    const throttle = createBackfillThrottle({
      script: 'testBackfill',
      pauseMs: 0,
      dryRun: true,
      env: {},
      config: { ...ALWAYS_OPEN, slowCeilingMs: 1_000, maxConsecutiveSlow: 1 },
      now: clock.now,
      sleep: clock.sleep,
      recordStop,
    });
    await throttle.beforeBatch({ cursor: 'c1' });
    clock.advance(5_000);
    await expect(throttle.beforeBatch({ cursor: 'c2' })).rejects.toBeInstanceOf(
      BackfillStoppedError,
    );
    expect(recordStop).not.toHaveBeenCalled();
  });

  it('measures the baseline again after sleeping through a closed window', async () => {
    const clock = fakeClock(at(6, 59) + 50_000);
    const { batch } = throttleOn(clock, { window: parseBackfillWindow('01-07') });
    for (let i = 0; i < 4; i += 1) await batch(100); // warm baseline 100 ms: slow above 1 s
    // The batch that crosses 07:00 is slow against it: back off, then sleep until 01:00.
    await batch(20_000);
    const slept = await batch(20_000);
    expect(slept[0]).toBe(15_000);
    expect(slept[1]).toBeGreaterThan(17 * HOUR);
    // Cold 20 s batches after the night: a fresh baseline, not backoff on every one.
    expect(await batch(20_000)).toEqual([100]);
    expect(await batch(20_000)).toEqual([100]);
  });

  it('only paces when backpressure is off', async () => {
    const clock = fakeClock(at(2));
    const { batch } = throttleOn(clock, { ...ALWAYS_OPEN, backpressure: false });
    for (let i = 0; i < 4; i += 1) await batch(100);
    await batch(600_000);
    expect(await batch(1)).toEqual([100]); // the 10-minute batch: no backoff
  });
});

describe('fixedPauseThrottle and the exit code', () => {
  it('pauses between batches, not before the first, and not at all at 0', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const paced = fixedPauseThrottle(250, sleep);
    await paced.beforeBatch();
    await paced.beforeBatch();
    await paced.beforeBatch();
    expect(sleeps).toEqual([250, 250]);
    const none = fixedPauseThrottle(0, sleep);
    await none.beforeBatch();
    await none.beforeBatch();
    expect(sleeps).toEqual([250, 250]);
  });

  it('exits 75 for a stopped run and 1 for anything else', () => {
    expect(backfillExitCode(new BackfillStoppedError('x', null))).toBe(75);
    expect(backfillExitCode(new Error('boom'))).toBe(1);
  });
});
