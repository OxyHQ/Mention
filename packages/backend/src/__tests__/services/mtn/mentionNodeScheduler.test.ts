import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { createRequire } from 'node:module';
import path from 'path';
import type * as TypeScript from 'typescript';

/**
 * MTN Protocol — B3 node scheduler (MentionNodeScheduler) + read-path invariant.
 *
 *  - The scheduler runs the liveness + sync sweeps ONLY in the background (on a
 *    deferred timer), never inline; `start()`/`stop()` are idempotent and cancel
 *    pending first-ticks.
 *  - The sync sweep routes `pull` nodes to ingest and `push` nodes to export.
 *  - READ INVARIANT (static guard): NO feed / hydration / controller code on the
 *    hot read path references the node table/repository, the node endpoints, or the node
 *    sync/registry services. All node I/O is background-only.
 */

const mockSweepLiveness = vi.fn();
const mockIngest = vi.fn();
const mockExport = vi.fn();
const mockFindNodesToSync = vi.fn();

vi.mock('../../../services/mtn/MentionNodeRegistryService', () => ({
  sweepNodeLiveness: (...a: unknown[]) => mockSweepLiveness(...a),
}));
vi.mock('../../../services/mtn/MentionNodeSyncService', () => ({
  ingestFromNode: (...a: unknown[]) => mockIngest(...a),
  exportToNode: (...a: unknown[]) => mockExport(...a),
}));
// The SEAM, not the store. What this file tests is the scheduler's timer and
// routing behaviour; which rows the sweep query returns — and the `NULLS FIRST`
// ordering that decides whether a new node is ever serviced at all — is pinned
// against real rows in `__tests__/db/mtnNodeRepository.test.ts`. Stubbing a
// named repository function keeps those two questions apart; stubbing the old
// Mongoose model conflated them and left the ordering covered by nothing.
vi.mock('../../../db/mtn/nodeRepository', () => ({
  findNodesToSync: (...a: unknown[]) => mockFindNodesToSync(...a),
}));

import { MentionNodeScheduler } from '../../../services/mtn/MentionNodeScheduler';
import {
  MENTION_NODE_LIVENESS_SWEEP_INTERVAL_MS,
  MENTION_NODE_INGEST_SWEEP_INTERVAL_MS,
} from '../../../services/mtn/mentionNodes.constants';

describe('MentionNodeScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSweepLiveness.mockResolvedValue(undefined);
    mockIngest.mockResolvedValue(undefined);
    mockExport.mockResolvedValue(undefined);
    mockFindNodesToSync.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT run any sweep synchronously on start (background only)', () => {
    const scheduler = new MentionNodeScheduler();
    scheduler.start();
    // Nothing fired yet — both sweeps are deferred behind a startup timer.
    expect(mockSweepLiveness).not.toHaveBeenCalled();
    expect(mockFindNodesToSync).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('runs the liveness + sync sweeps after their startup delay', async () => {
    mockFindNodesToSync.mockResolvedValue([
      { oxyUserId: 'u-pull', mode: 'pull' },
      { oxyUserId: 'u-push', mode: 'push' },
    ]);
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
    mockFindNodesToSync.mockResolvedValue([{ oxyUserId: 'u-pull', mode: 'pull' }]);
    let releaseIngest: (() => void) | undefined;
    mockIngest.mockImplementation(
      () => new Promise<void>((resolve) => { releaseIngest = resolve; }),
    );

    const scheduler = new MentionNodeScheduler();
    scheduler.start();

    // First sync tick (after its 90s startup delay) begins and blocks in ingest.
    await vi.advanceTimersByTimeAsync(91_000);
    expect(mockFindNodesToSync).toHaveBeenCalledTimes(1);
    expect(mockIngest).toHaveBeenCalledTimes(1);

    // Interval boundaries pass while ingest is blocked — the guard skips them, so
    // the node query is not re-run and ingest is not re-invoked.
    await vi.advanceTimersByTimeAsync(MENTION_NODE_INGEST_SWEEP_INTERVAL_MS * 3);
    expect(mockFindNodesToSync).toHaveBeenCalledTimes(1);
    expect(mockIngest).toHaveBeenCalledTimes(1);

    // Unblock the sweep; the next tick is then free to run a fresh sweep.
    releaseIngest?.();
    await vi.advanceTimersByTimeAsync(MENTION_NODE_INGEST_SWEEP_INTERVAL_MS);
    expect(mockFindNodesToSync).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });
});

const ts = createRequire(path.join(__dirname, 'mentionNodeScheduler.test.ts'))(
  'typescript',
) as typeof TypeScript;

describe('Read-path invariant — feeds/hydration never touch a node', () => {
  const BACKEND_ROOT = path.resolve(__dirname, '../../../../');
  // Hot read-path modules: anything a feed/hydration request executes. None may
  // reference the node model, node endpoints, or the node services.
  const HOT_PATH_DIRS = ['src/mtn/feed', 'src/controllers', 'src/services'];
  // The node layer itself is the ONLY place node I/O is allowed — exclude it.
  const NODE_LAYER = `${path.join('src', 'services', 'mtn')}${path.sep}`;
  const FORBIDDEN = [
    // Re-expressed when the Mongoose `MentionUserNode` model gave way to
    // Postgres. The invariant is unchanged — no hot-path module may reach the
    // node table — but the symbol that names it is now the drizzle table, so
    // the token had to move with it or it would match nothing and enforce
    // nothing. The floor below is what forced this rather than letting the
    // check quietly retire.
    'mentionUserNodes',
    'nodeRepository',
    'MentionNodeSyncService',
    'MentionNodeRegistryService',
    'MentionNodeScheduler',
    'ingestFromNode',
    'exportToNode',
    'oxy-node.json',
  ];
  /**
   * One file per hot-path directory that the walk MUST reach, each of them
   * nested rather than top-level.
   *
   * The old walk swallowed a `readdirSync` failure and returned `[]`, so a
   * renamed or relocated directory scanned nothing and the invariant passed for
   * every violation — indistinguishable, from the outside, from a clean tree. A
   * file count would not fix that on its own: a directory can exist and still
   * not be recursed into. Naming a nested file each directory must yield is what
   * separates "the scan ran and found nothing" from "the scan never ran".
   */
  const ANCHOR_FILES = [
    'src/mtn/feed/engine/sources/discoverySources.ts',
    'src/controllers/feed.controller.ts',
    'src/services/safety/viewerSafety.ts',
  ];

  function productionFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory)) {
      if (entry === '__tests__' || entry === 'dist' || entry === 'node_modules') continue;
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        files.push(...productionFiles(absolute));
      } else if (absolute.endsWith('.ts') && !absolute.endsWith('.test.ts')) {
        files.push(absolute);
      }
    }
    return files;
  }

  /**
   * Which forbidden tokens a file actually REFERENCES, off the AST.
   *
   * A substring search over raw text counts a docblock, and this branch
   * documents replaced behaviour everywhere — so the check that fires is as
   * likely to be describing the node layer as calling it. Identifiers match
   * exactly; string literals match on substring, because that is how an import
   * specifier (`'../../db/mtn/nodeRepository'`) and an endpoint path
   * (`'/oxy-node.json'`) carry the reference.
   */
  function referencedTokens(sourceFile: TypeScript.SourceFile): string[] {
    const found = new Set<string>();
    const visit = (node: TypeScript.Node): void => {
      if (ts.isIdentifier(node)) {
        if (FORBIDDEN.includes(node.text)) found.add(node.text);
      } else if (
        ts.isStringLiteralLike(node)
        || ts.isTemplateHead(node)
        || ts.isTemplateMiddle(node)
        || ts.isTemplateTail(node)
      ) {
        for (const token of FORBIDDEN) {
          if (node.text.includes(token)) found.add(token);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return [...found].sort();
  }

  function parse(file: string, source: string): TypeScript.SourceFile {
    return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  }

  it('detects a node reference and ignores one that is only described', () => {
    // The positive control for the scan below, driving the SAME function it
    // does. Without it, "no offenders" is equally consistent with a detector
    // that can no longer detect anything.
    const detected = referencedTokens(
      parse(
        path.join(__dirname, 'referencedTokens.control.ts'),
        [
          "import { findUserNode } from '../db/mtn/nodeRepository';",
          'const table = mentionUserNodes;',
          "const endpoint = '/oxy-node.json';",
          '// A comment naming MentionNodeSyncService must NOT count.',
          '/** Nor a docblock naming MentionNodeScheduler and exportToNode. */',
          'export const model = table;',
          'export const url = `${endpoint}?x=1`;',
        ].join('\n'),
      ),
    );

    expect(detected).toEqual(['mentionUserNodes', 'nodeRepository', 'oxy-node.json']);
  });

  it('no hot-path module references a node model / endpoint / sync service', () => {
    const scanned = productionFiles(path.join(BACKEND_ROOT, 'src')).map((file) => ({
      relative: path.relative(BACKEND_ROOT, file),
      tokens: referencedTokens(parse(file, readFileSync(file, 'utf8'))),
    }));
    const hotPath = scanned.filter(
      (entry) =>
        HOT_PATH_DIRS.some(
          (dir) => entry.relative === dir || entry.relative.startsWith(`${dir}${path.sep}`),
        )
        && !entry.relative.startsWith(NODE_LAYER),
    );

    // FLOOR — the walk reached every hot-path directory, and recursed into it.
    expect(
      ANCHOR_FILES.filter(
        (anchor) => !hotPath.some((entry) => entry.relative === path.normalize(anchor)),
      ),
    ).toEqual([]);

    // FLOOR — every forbidden token still NAMES something. A token whose symbol
    // has been deleted (as `MentionUserNode` was, the moment the Mongoose model
    // gave way to `db/schema/mtn`'s `mentionUserNodes`) can never match again, and
    // the invariant it stood for quietly stops being enforced. When this fails,
    // re-express the token against the replacement symbol — do not delete it.
    const reachable = new Set(scanned.flatMap((entry) => entry.tokens));
    expect(FORBIDDEN.filter((token) => !reachable.has(token))).toEqual([]);

    const offenders = hotPath.flatMap((entry) =>
      entry.tokens.map((token) => `${entry.relative} references "${token}"`),
    );
    expect(offenders).toEqual([]);
  }, 60_000);
});
