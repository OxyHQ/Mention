import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

/**
 * MTN Protocol — B3 node scheduler (MentionNodeScheduler) + read-path invariant.
 *
 *  - The scheduler runs the liveness + sync sweeps ONLY in the background (on a
 *    deferred timer), never inline; `start()`/`stop()` are idempotent and cancel
 *    pending first-ticks.
 *  - The sync sweep routes `pull` nodes to ingest and `push` nodes to export.
 *  - READ INVARIANT (static guard): NO feed / hydration / controller code on the
 *    hot read path references `MentionUserNode`, the node endpoints, or the node
 *    sync/registry services. All node I/O is background-only.
 */

const mockSweepLiveness = vi.fn();
const mockIngest = vi.fn();
const mockExport = vi.fn();
const mockNodeFind = vi.fn();

vi.mock('../../../services/mtn/MentionNodeRegistryService', () => ({
  sweepNodeLiveness: (...a: unknown[]) => mockSweepLiveness(...a),
}));
vi.mock('../../../services/mtn/MentionNodeSyncService', () => ({
  ingestFromNode: (...a: unknown[]) => mockIngest(...a),
  exportToNode: (...a: unknown[]) => mockExport(...a),
}));
vi.mock('../../../models/MentionUserNode', () => ({
  __esModule: true,
  default: { find: (...a: unknown[]) => mockNodeFind(...a) },
}));

import { MentionNodeScheduler } from '../../../services/mtn/MentionNodeScheduler';
import {
  MENTION_NODE_LIVENESS_SWEEP_INTERVAL_MS,
  MENTION_NODE_INGEST_SWEEP_INTERVAL_MS,
} from '../../../services/mtn/mentionNodes.constants';

function findLean(rows: unknown) {
  return { sort: () => ({ limit: () => ({ select: () => ({ lean: () => Promise.resolve(rows) }) }) }) };
}

describe('MentionNodeScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSweepLiveness.mockResolvedValue(undefined);
    mockIngest.mockResolvedValue(undefined);
    mockExport.mockResolvedValue(undefined);
    mockNodeFind.mockReturnValue(findLean([]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT run any sweep synchronously on start (background only)', () => {
    const scheduler = new MentionNodeScheduler();
    scheduler.start();
    // Nothing fired yet — both sweeps are deferred behind a startup timer.
    expect(mockSweepLiveness).not.toHaveBeenCalled();
    expect(mockNodeFind).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('runs the liveness + sync sweeps after their startup delay', async () => {
    mockNodeFind.mockReturnValue(
      findLean([
        { oxyUserId: 'u-pull', mode: 'pull' },
        { oxyUserId: 'u-push', mode: 'push' },
      ]),
    );
    const scheduler = new MentionNodeScheduler();
    scheduler.start();

    // Advance past both startup delays (liveness 60s, sync 90s) and flush the
    // async sweep bodies.
    await vi.advanceTimersByTimeAsync(95_000);

    expect(mockSweepLiveness).toHaveBeenCalled();
    // pull → ingest, push → export.
    expect(mockIngest).toHaveBeenCalledWith('u-pull');
    expect(mockExport).toHaveBeenCalledWith('u-push');
    scheduler.stop();
  });

  it('stop() cancels pending first-ticks so no sweep runs after stop', async () => {
    const scheduler = new MentionNodeScheduler();
    scheduler.start();
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(200_000);

    expect(mockSweepLiveness).not.toHaveBeenCalled();
    expect(mockIngest).not.toHaveBeenCalled();
    expect(mockExport).not.toHaveBeenCalled();
  });

  it('start() is idempotent (a second start does not double-schedule)', async () => {
    const scheduler = new MentionNodeScheduler();
    scheduler.start();
    scheduler.start();

    await vi.advanceTimersByTimeAsync(95_000);

    // Only ONE liveness sweep fired despite two start() calls.
    expect(mockSweepLiveness).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('does NOT overlap liveness sweeps when one outlasts its interval', async () => {
    // A liveness sweep that never resolves: every subsequent interval tick must
    // be skipped by the re-entrancy guard rather than starting a 2nd sweep.
    let releaseSweep: (() => void) | undefined;
    mockSweepLiveness.mockImplementation(
      () => new Promise<void>((resolve) => { releaseSweep = resolve; }),
    );

    const scheduler = new MentionNodeScheduler();
    scheduler.start();

    // First tick (after the startup delay) starts the long-running sweep.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(mockSweepLiveness).toHaveBeenCalledTimes(1);

    // Several more interval boundaries pass while the first sweep is still in
    // flight — none may start a second sweep.
    await vi.advanceTimersByTimeAsync(MENTION_NODE_LIVENESS_SWEEP_INTERVAL_MS * 3);
    expect(mockSweepLiveness).toHaveBeenCalledTimes(1);

    // Let the in-flight sweep finish; the next tick is then free to run.
    releaseSweep?.();
    await vi.advanceTimersByTimeAsync(MENTION_NODE_LIVENESS_SWEEP_INTERVAL_MS);
    expect(mockSweepLiveness).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it('does NOT overlap sync sweeps when one outlasts its interval', async () => {
    // A sync sweep blocks in ingest: hold it open and assert no second sweep
    // starts (the node query is not re-run) on the following ticks.
    mockNodeFind.mockReturnValue(findLean([{ oxyUserId: 'u-pull', mode: 'pull' }]));
    let releaseIngest: (() => void) | undefined;
    mockIngest.mockImplementation(
      () => new Promise<void>((resolve) => { releaseIngest = resolve; }),
    );

    const scheduler = new MentionNodeScheduler();
    scheduler.start();

    // First sync tick (after its 90s startup delay) begins and blocks in ingest.
    await vi.advanceTimersByTimeAsync(91_000);
    expect(mockNodeFind).toHaveBeenCalledTimes(1);
    expect(mockIngest).toHaveBeenCalledTimes(1);

    // Interval boundaries pass while ingest is blocked — the guard skips them, so
    // the node query is not re-run and ingest is not re-invoked.
    await vi.advanceTimersByTimeAsync(MENTION_NODE_INGEST_SWEEP_INTERVAL_MS * 3);
    expect(mockNodeFind).toHaveBeenCalledTimes(1);
    expect(mockIngest).toHaveBeenCalledTimes(1);

    // Unblock the sweep; the next tick is then free to run a fresh sweep.
    releaseIngest?.();
    await vi.advanceTimersByTimeAsync(MENTION_NODE_INGEST_SWEEP_INTERVAL_MS);
    expect(mockNodeFind).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });
});

describe('Read-path invariant — feeds/hydration never touch a node', () => {
  // Hot read-path modules: anything a feed/hydration request executes. None may
  // reference the node model, node endpoints, or the node services.
  const HOT_PATH_DIRS = ['src/mtn/feed', 'src/controllers', 'src/services'];
  // The node layer itself is the ONLY place node I/O is allowed — exclude it.
  const NODE_LAYER = path.normalize('src/services/mtn');
  const FORBIDDEN = [
    'MentionUserNode',
    'MentionNodeSyncService',
    'MentionNodeRegistryService',
    'MentionNodeScheduler',
    'ingestFromNode',
    'exportToNode',
    'oxy-node.json',
  ];

  function walk(dir: string): string[] {
    const abs = path.resolve(__dirname, '../../../../', dir);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(abs, entry);
      const rel = path.relative(path.resolve(__dirname, '../../../../'), full);
      // The node layer (src/services/mtn) is the allowed home of node I/O.
      if (path.normalize(rel).startsWith(NODE_LAYER)) continue;
      if (statSync(full).isDirectory()) {
        files.push(...walk(rel));
      } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
        files.push(full);
      }
    }
    return files;
  }

  it('no hot-path module references a node model / endpoint / sync service', () => {
    const offenders: string[] = [];
    for (const dir of HOT_PATH_DIRS) {
      for (const file of walk(dir)) {
        const content = readFileSync(file, 'utf8');
        for (const token of FORBIDDEN) {
          if (content.includes(token)) {
            offenders.push(`${path.basename(file)} references "${token}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
