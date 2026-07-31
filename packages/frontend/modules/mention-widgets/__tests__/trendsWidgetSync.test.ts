import {
  MIN_TRENDS_WIDGET_SYNC_INTERVAL_MS,
  shouldSyncTrendsWidget,
} from '../trendsWidgetSync';

/**
 * When the app tells the Android home-screen trends widget to fetch again.
 *
 * Nothing here touches Android. No WorkManager job, no Glance composition and no
 * launcher is reachable from jest — those need a device build. What IS pinned is
 * the whole decision made before the native call: which responses are worth a
 * background fetch, which are not, and that a response we decided to skip cannot
 * make us skip the next one too.
 */

const mockRefreshTrendsWidget = jest.fn<Promise<void>, []>();
const mockDebug = jest.fn();

jest.mock('../index', () => ({
  refreshTrendsWidget: () => mockRefreshTrendsWidget(),
}));

<<<<<<< HEAD
jest.mock('@oxyhq/core/logger', () => ({
  ...jest.requireActual('@oxyhq/core/logger'),
=======
jest.mock('@/lib/logger', () => ({
>>>>>>> eb94101b (chore: sync latest frontend/backend changes)
  logger: { debug: (...args: unknown[]) => mockDebug(...args) },
}));

/**
 * A fresh copy of the module, because its bookkeeping is module state — the
 * point of which is that it survives across calls, so it has to be reset
 * between tests rather than between calls.
 *
 * `require` rather than `import()`: babel-preset-expo leaves dynamic import
 * native, and jest's CommonJS runtime rejects it without
 * `--experimental-vm-modules`. This is also the only form that re-reads the
 * registry `resetModules` just cleared.
 */
function loadSync(): typeof import('../trendsWidgetSync') {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
  return require('../trendsWidgetSync');
}

beforeEach(() => {
  mockRefreshTrendsWidget.mockReset();
  mockRefreshTrendsWidget.mockResolvedValue(undefined);
  mockDebug.mockReset();
});

describe('shouldSyncTrendsWidget', () => {
  it('does nothing without a batch token: a rotation is indistinguishable from a repeat', () => {
    expect(
      shouldSyncTrendsWidget({
        recId: undefined,
        lastSyncedRecId: null,
        lastSyncedAtMs: null,
        nowMs: 1_000_000,
      }),
    ).toBe(false);
  });

  it('syncs the first batch it ever sees', () => {
    expect(
      shouldSyncTrendsWidget({
        recId: 'batch-1',
        lastSyncedRecId: null,
        lastSyncedAtMs: null,
        nowMs: 1_000_000,
      }),
    ).toBe(true);
  });

  it('does nothing for a batch the widget already has', () => {
    expect(
      shouldSyncTrendsWidget({
        recId: 'batch-1',
        lastSyncedRecId: 'batch-1',
        lastSyncedAtMs: 0,
        nowMs: 10 * MIN_TRENDS_WIDGET_SYNC_INTERVAL_MS,
      }),
    ).toBe(false);
  });

  it('holds a new batch back while the last sync is still inside the interval', () => {
    expect(
      shouldSyncTrendsWidget({
        recId: 'batch-2',
        lastSyncedRecId: 'batch-1',
        lastSyncedAtMs: 1_000_000,
        nowMs: 1_000_000 + MIN_TRENDS_WIDGET_SYNC_INTERVAL_MS - 1,
      }),
    ).toBe(false);
  });

  it('lets a new batch through once the interval has elapsed exactly', () => {
    expect(
      shouldSyncTrendsWidget({
        recId: 'batch-2',
        lastSyncedRecId: 'batch-1',
        lastSyncedAtMs: 1_000_000,
        nowMs: 1_000_000 + MIN_TRENDS_WIDGET_SYNC_INTERVAL_MS,
      }),
    ).toBe(true);
  });

  it('keeps the same-batch rule above the interval rule', () => {
    // Long past the interval, but still the batch the widget already has.
    expect(
      shouldSyncTrendsWidget({
        recId: 'batch-1',
        lastSyncedRecId: 'batch-1',
        lastSyncedAtMs: 0,
        nowMs: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(false);
  });
});

describe('syncTrendsWidget', () => {
  it('nudges the widget once for a new batch and not again for the same one', () => {
    const { syncTrendsWidget } = loadSync();

    syncTrendsWidget('batch-1', 1_000_000);
    expect(mockRefreshTrendsWidget).toHaveBeenCalledTimes(1);

    // Same batch, and far enough out that only the batch rule can be stopping it.
    syncTrendsWidget('batch-1', 1_000_000 + 10 * MIN_TRENDS_WIDGET_SYNC_INTERVAL_MS);
    expect(mockRefreshTrendsWidget).toHaveBeenCalledTimes(1);
  });

  it('never nudges for a response with no batch token', () => {
    const { syncTrendsWidget } = loadSync();

    syncTrendsWidget(undefined, 1_000_000);

    expect(mockRefreshTrendsWidget).not.toHaveBeenCalled();
  });

  it('does not let a rate-limited batch suppress itself once the interval passes', () => {
    const { syncTrendsWidget } = loadSync();

    syncTrendsWidget('batch-1', 1_000_000);
    expect(mockRefreshTrendsWidget).toHaveBeenCalledTimes(1);

    // Inside the interval: skipped, and — the part that matters — NOT recorded as
    // the batch we last synced. Recording it here would mean this batch never
    // reached the widget at all.
    syncTrendsWidget('batch-2', 1_000_000 + 1);
    expect(mockRefreshTrendsWidget).toHaveBeenCalledTimes(1);

    syncTrendsWidget('batch-2', 1_000_000 + MIN_TRENDS_WIDGET_SYNC_INTERVAL_MS);
    expect(mockRefreshTrendsWidget).toHaveBeenCalledTimes(2);
  });

  it('swallows a failed nudge instead of surfacing it to the reader', async () => {
    const { syncTrendsWidget } = loadSync();
    mockRefreshTrendsWidget.mockRejectedValue(new Error('no work manager'));

    // Node aborts the whole process on an unhandled rejection, which would fail
    // this suite without saying which test did it. Holding a listener for the
    // duration keeps the failure inside the test, so a `syncTrendsWidget` that
    // stopped handling its own rejection is reported by the assertions below
    // rather than by a stack trace with no test name attached.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      expect(() => syncTrendsWidget('batch-1', 1_000_000)).not.toThrow();

      // Rejection handling and the unhandled-rejection check both land on later
      // ticks; two macrotasks is enough for either to have happened.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockDebug).toHaveBeenCalledWith(
        'Could not nudge the trends widget',
        expect.objectContaining({ error: expect.any(Error) }),
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
