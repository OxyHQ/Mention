/**
 * The gate that makes `isolatedDatabaseFiles.ts` ASSERTABLE rather than remembered.
 *
 * The suite shares ONE Postgres for the whole run, and a handful of test files
 * invoke background jobs that page over whole tables and rewrite whatever they
 * find. Those files get a private database in `setup.ts`; this test scans every
 * `*.test.ts` for calls to those job entry points and fails, naming the file, if
 * a caller is not listed.
 *
 * ## What this gate does and does NOT cover
 *
 * It covers a NEW CALLER of a KNOWN job. It cannot discover a TWELFTH unscoped
 * job — only a fresh scan of the write path can do that — so the list's
 * completeness rests on how it was built, which is worth stating because the
 * obvious method does not work:
 *
 * The list came from scanning for UNSCOPED DRIZZLE WRITES (an `update`/`delete`
 * whose `where` names no owner; a `select` whose predicate is a status alone),
 * NOT from job-sounding names. A `Reconcil|Dispatch|Sweep|Job|Scheduler` sweep
 * finds nine of the eleven files and provably misses the classification cycle:
 * `PostClassificationService` contains none of those substrings, and its two
 * global writers are named `markEmptyPosts` and `classifyBatch`.
 *
 * That same entry carries the trap in miniature, and it is the reason a name
 * sweep is not enough on its own. `markEmptyPosts`'s docstring reads "Bounded to
 * the pending set." That is TRUE — and it is not a CALLER bound: the pending set
 * is every pending post in the database, not the calling file's. An auditor
 * asking "does it bound its work?" gets a yes and moves on. The blocklist sweep
 * has the same shape from the other direction: it accepts an injectable poll, so
 * it reads as scoped, while the ledger rows it rewrites are every open proposal
 * there is. A bound that is real, but is not the caller's.
 *
 * `markEmptyPosts` is also `private`, so a gate keyed on ITS name would find
 * zero callers, pass forever and protect nothing — the entry point below is the
 * PUBLIC cycle a test can actually reach.
 *
 * ## Connection budget — measured, and the measurement has a known blind spot
 *
 * Each listed file creates its own database, which costs one extra
 * `bun run db:migrate` subprocess on top of the run's usual load. The config's
 * own budget is `maxWorkers` 10 x `PG_MAX_POOL_SIZE` 8 = 80 against a
 * `max_connections` of 100, and a full ~490-file run was measured at a PEAK of
 * 60 concurrent connections with the eleven isolated databases in play.
 *
 * That sample was taken at 1 Hz on a dedicated local container, so it CANNOT
 * see a sub-second spike while the eleven migrate subprocesses start together,
 * and CI's Postgres is not the instance it was taken on. If a run ever fails
 * here with `sorry, too many clients already`, that is the gap — re-measure at
 * a higher sampling rate against CI's own database before changing `maxWorkers`
 * or `PG_MAX_POOL_SIZE`, rather than treating 60 as headroom that was proven.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ISOLATED_DATABASE_FILES,
  needsIsolatedDatabase,
} from './isolatedDatabaseFiles';

/** `packages/backend/` — the root the listed paths are relative to. */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');
/** The tree every `*.test.ts` in this package lives under. */
const TESTS_ROOT = join(PACKAGE_ROOT, 'src', '__tests__');

/**
 * Floor on how many test files the traversal must find.
 *
 * Without it, a traversal that silently returns nothing reports zero unlisted
 * callers and reads exactly like a clean tree. 400 against the ~490 files
 * present leaves room for real churn while still failing a walk that broke.
 */
const MIN_SCANNED_TEST_FILES = 400;

/** One unscoped background job, and how a test file's call to it is spelled. */
interface JobEntryPoint {
  /** Must equal the `jobEntryPoint` recorded on the list entries it explains. */
  readonly name: string;
  /**
   * Matches an INVOCATION, not a mention: the name followed by `(`. An import
   * specifier, an object key and a bare identifier all fail it, so a file that
   * merely re-exports or mocks the job is not dragged in.
   *
   * Methods are matched with their leading `.` so a same-named free function
   * elsewhere cannot be mistaken for this job.
   */
  readonly call: RegExp;
}

const JOB_ENTRY_POINTS: readonly JobEntryPoint[] = [
  { name: 'reconcileEngagementProjections', call: /\breconcileEngagementProjections\s*\(/ },
  { name: 'dispatchEngagementOutbox', call: /\bdispatchEngagementOutbox\s*\(/ },
  { name: 'dispatchModerationOutbox', call: /\bdispatchModerationOutbox\s*\(/ },
  { name: 'reconcileModerationReports', call: /\breconcileModerationReports\s*\(/ },
  { name: 'publishDuePosts', call: /\.publishDuePosts\s*\(/ },
  { name: 'runSnapshotSweep', call: /\.runSnapshotSweep\s*\(/ },
  { name: 'runBlocklistProposalSweep', call: /\brunBlocklistProposalSweep\s*\(/ },
  { name: 'sweepExpiredRows', call: /\bsweepExpiredRows\s*\(/ },
  { name: 'reconcileBlockedDomainPurges', call: /\breconcileBlockedDomainPurges\s*\(/ },
  { name: 'processQueue', call: /\.processQueue\s*\(/ },
];

/** Every `*.test.ts` under `src/__tests__/`, as paths relative to the package root. */
function collectTestFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      found.push(...collectTestFiles(absolute));
      continue;
    }
    if (entry.endsWith('.test.ts')) {
      found.push(absolute.slice(PACKAGE_ROOT.length + 1).split(sep).join('/'));
    }
  }
  return found;
}

const testFiles = collectTestFiles(TESTS_ROOT);
const sourceByFile = new Map(
  testFiles.map((file) => [file, readFileSync(join(PACKAGE_ROOT, file), 'utf8')] as const),
);

/** Files calling `entryPoint`, in scan order. */
function callersOf(entryPoint: JobEntryPoint): string[] {
  return testFiles.filter((file) => entryPoint.call.test(sourceByFile.get(file) ?? ''));
}

describe('isolated-database file list', () => {
  it('scanned enough test files to be able to fail', () => {
    expect(testFiles.length).toBeGreaterThanOrEqual(MIN_SCANNED_TEST_FILES);
    // A traversal can return names without content; every file must have been
    // read, or the caller scan above is asserting over empty strings.
    expect(sourceByFile.size).toBe(testFiles.length);
    for (const file of testFiles) {
      expect(sourceByFile.get(file)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('names an entry point that some test actually calls', () => {
    // A renamed or deleted job would otherwise make its pattern match nothing,
    // and a pattern that matches nothing can never report an unlisted caller.
    for (const entryPoint of JOB_ENTRY_POINTS) {
      expect(
        callersOf(entryPoint),
        `no test file calls "${entryPoint.name}" — the pattern is stale, and a ` +
        'pattern that cannot match cannot fail',
      ).not.toHaveLength(0);
    }
  });

  it('lists every test file that invokes an unscoped background job', () => {
    const listed = new Set(ISOLATED_DATABASE_FILES.map((entry) => entry.path));

    for (const entryPoint of JOB_ENTRY_POINTS) {
      for (const file of callersOf(entryPoint)) {
        expect(
          listed.has(file),
          `${file} calls ${entryPoint.name}, which rewrites rows it does not own, ` +
          'but it is missing from ISOLATED_DATABASE_FILES — it will run against ' +
          "the shared database and corrupt other files' rows. Add it there.",
        ).toBe(true);
      }
    }
  });

  it('has no entry that no longer calls the job it claims', () => {
    for (const entry of ISOLATED_DATABASE_FILES) {
      const entryPoint = JOB_ENTRY_POINTS.find((job) => job.name === entry.jobEntryPoint);
      expect(
        entryPoint,
        `${entry.path} names job entry point "${entry.jobEntryPoint}", which this ` +
        'scanner does not know about — the two lists have drifted',
      ).toBeDefined();
      if (!entryPoint) continue;

      expect(
        sourceByFile.has(entry.path),
        `${entry.path} is listed but does not exist — a moved or deleted file ` +
        'isolates nothing while still reading as covered',
      ).toBe(true);
      expect(
        entryPoint.call.test(sourceByFile.get(entry.path) ?? ''),
        `${entry.path} no longer calls ${entry.jobEntryPoint}; drop the entry ` +
        'rather than paying for a database it does not need',
      ).toBe(true);
    }
  });

  it('accounts for every caller found, so the two lists cannot drift apart', () => {
    const callers = new Set(JOB_ENTRY_POINTS.flatMap((entryPoint) => callersOf(entryPoint)));
    expect(callers.size).toBe(ISOLATED_DATABASE_FILES.length);
  });

  it('gives each entry a reason naming what the job reaches', () => {
    for (const entry of ISOLATED_DATABASE_FILES) {
      expect(entry.reason.length, `${entry.path} has no reason recorded`).toBeGreaterThan(40);
    }
  });
});

describe('needsIsolatedDatabase', () => {
  it('matches the absolute path vitest reports for every listed file', () => {
    for (const entry of ISOLATED_DATABASE_FILES) {
      expect(
        needsIsolatedDatabase(join(PACKAGE_ROOT, entry.path)),
        `${entry.path} is listed but would not be matched at run time`,
      ).toBe(true);
    }
  });

  it('does not match a file that only shares a basename', () => {
    // The suffix carries the whole `src/__tests__/…` prefix precisely so a
    // same-named file somewhere else in the tree cannot claim isolation.
    const listed = ISOLATED_DATABASE_FILES[0]?.path ?? '';
    const basename = listed.slice(listed.lastIndexOf('/') + 1);
    expect(needsIsolatedDatabase(join(PACKAGE_ROOT, 'src', '__tests__', basename))).toBe(false);
    expect(needsIsolatedDatabase(join(PACKAGE_ROOT, 'src/__tests__/appFactory.test.ts'))).toBe(false);
  });

  it('is not satisfied by a partial path segment', () => {
    const listed = ISOLATED_DATABASE_FILES[0]?.path ?? '';
    expect(needsIsolatedDatabase(join(PACKAGE_ROOT, `x${listed}`))).toBe(false);
  });
});
