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
 * It covers a NEW CALLER of a KNOWN job. It cannot discover a job it has never
 * been told about — only a fresh scan of the write path can do that — so the
 * list's completeness rests on how it was built, which is worth stating because
 * the obvious method does not work:
 *
 * **That limitation has now cost a real CI failure, and the follow-up scan found
 * TEN more.** `backfillFederatedThreadLinks` surfaced as an intermittent
 * `run incomplete: unresolved=1` — green on the commits either side, so it read
 * as a flake — and this gate could not have caught it, exactly as it said. The
 * scan that followed checked every `*.test.ts` for a call into a module whose
 * DRIVING SELECT names no owner, and the answers cluster in
 * `src/__tests__/scripts/`: an admin one-shot is a whole-table reconciler by
 * definition, and the first list was built from `src/services/`, where a global
 * sweep is the exception rather than the rule. So the gap was a category, not a
 * set of individual oversights.
 *
 * **Read the DRIVING SELECT, never the write's `where`.** All ten update by
 * primary key, which looks perfectly scoped at the write; what is unscoped is the
 * query that chose the key.
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
 * ## A KNOWN UNCOVERED SHAPE: an unscoped write that is not a job
 *
 * This list covers files that invoke a background JOB. It does NOT cover a file
 * that reaches a globally-scoped SERVICE directly, and at least one such writer
 * is known to exist against `post_recent_repliers`. Do not read the list as an
 * inventory of every way one test file can write another's rows.
 *
 * Measured rather than suspected. `src/__tests__/scripts/purgeBlockedDomainContent.test.ts`
 * calls none of the entry points below and scopes its own writes, yet it fails
 * intermittently on `recentReplierEntriesPulled` — a projection row it seeded,
 * gone before its purge ran. It failed that way BEFORE per-file isolation
 * existed and again in one of three full runs AFTER it, so its offender is not
 * among the eleven and a private database does not address it. The likely shape
 * is `PostRecentReplierService` reached straight from an ordinary test file,
 * which no entry point below can match.
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
import { SCRIPT_SCOPE } from './scriptScope';

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

  /*
   * The admin one-shots, added by the second scan. Each is keyed on the IMPORTED
   * script rather than on whatever local wrapper a suite happens to define —
   * `backfillFederatedBanners.test.ts` calls it through a local `runBackfill()`,
   * and keying on that name would match any file that coined the same helper.
   */
  { name: 'backfillFederatedThreadLinks', call: /\bbackfillFederatedThreadLinks\s*\(/ },
  { name: 'normalizeStoredText', call: /\bnormalizeStoredText\s*\(/ },
  { name: 'purgeGoneFederatedActors', call: /\bpurgeGoneFederatedActors\s*\(/ },
  { name: 'repairFederatedMentions', call: /\brepairFederatedMentions\s*\(/ },
  { name: 'backfillThreadRootThreadId', call: /\bbackfillThreadRootThreadId\s*\(/ },
  { name: 'migrateThreadFanToChain', call: /\bmigrateThreadFanToChain\s*\(/ },
  { name: 'backfillMtnRecords', call: /\bbackfillMtnRecords\s*\(/ },
  { name: 'backfillFederatedBanners', call: /\bbackfillFederatedBanners\s*\(/ },
  {
    name: 'backfillFederatedHandleQualification',
    call: /\bbackfillFederatedHandleQualification\s*\(/,
  },
  { name: 'backfillQuotedPosts', call: /\bbackfillQuotedPosts\s*\(/ },
  { name: 'backfillPostLanguages', call: /\bbackfillPostLanguages\s*\(/ },
  { name: 'backfillCustomFeedDefinitions', call: /\bbackfillCustomFeedDefinitions\s*\(/ },
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

/**
 * Every `src/scripts/…` specifier a test file imports, and who imports it.
 *
 * Matches the IMPORT rather than the call, and deliberately not a directory: the
 * two most recently discovered whole-table reconcilers
 * (`backfillPostLanguages`, `backfillCustomFeedDefinitions`) have their suites at
 * the top of `src/__tests__/`, so a rule keyed on `src/__tests__/scripts/`
 * reports them clean. A deeper relative prefix and a shallower one state the
 * same fact about the same module, so the pattern accepts any depth.
 *
 * This file is scanned by its own regex like every other, which is deliberate —
 * excluding the scanner from its own scan is the hole that hides the next real
 * caller. So no example here is written in the matching form.
 */
const SCRIPT_IMPORT = /from '(?:\.\.\/)+scripts\/([A-Za-z0-9._/-]+)'/g;

function scriptImportsOf(source: string): string[] {
  return [...source.matchAll(SCRIPT_IMPORT)].map((match) => match[1] ?? '');
}

const scriptImportsByFile = new Map(
  testFiles.map((file) => [file, scriptImportsOf(sourceByFile.get(file) ?? '')] as const),
);

describe('script scope declarations', () => {
  it('found script imports at all, so an empty scan cannot read as clean', () => {
    const total = [...scriptImportsByFile.values()].reduce((sum, list) => sum + list.length, 0);
    // 20 against the ~28 importing files present: a floor that survives churn
    // while still failing a regex that stopped matching.
    expect(total).toBeGreaterThanOrEqual(20);
  });

  it('classifies every script a test imports', () => {
    for (const [file, specifiers] of scriptImportsByFile) {
      for (const specifier of specifiers) {
        expect(
          SCRIPT_SCOPE[specifier],
          `${file} imports src/scripts/${specifier}, which has no entry in SCRIPT_SCOPE. ` +
          'Classify it: does its DRIVING SELECT name an owner, or does it page a whole ' +
          'table? Read the select that CHOOSES the rows, not the where on the write — ' +
          'every known offender updates by primary key.',
        ).toBeDefined();
      }
    }
  });

  it('isolates every test that drives a whole-table script', () => {
    /**
     * THE PROPERTY THREE SEPARATE SCANS EACH GOT A DIFFERENT ANSWER TO, now
     * derived from imports instead of from wherever somebody chose to look.
     */
    for (const [file, specifiers] of scriptImportsByFile) {
      for (const specifier of specifiers) {
        if (SCRIPT_SCOPE[specifier]?.scope !== 'whole-table') continue;
        expect(
          needsIsolatedDatabase(join(PACKAGE_ROOT, file)),
          `${file} imports src/scripts/${specifier}, declared "whole-table" — it pages a ` +
          'whole table and rewrites what it finds, so on the shared database it reaches ' +
          "rows other files own. Add it to ISOLATED_DATABASE_FILES.",
        ).toBe(true);
      }
    }
  });

  it('gives every caller-scoped declaration a reason, since that is the claim', () => {
    // A `whole-table` entry is enforced by the check above; a `caller-scoped`
    // one is a human assertion that nothing enforces, so it has to say why.
    for (const [specifier, declaration] of Object.entries(SCRIPT_SCOPE)) {
      expect(
        declaration.reason.length,
        `${specifier} is declared "${declaration.scope}" with no reason recorded`,
      ).toBeGreaterThan(40);
    }
  });

  it('has no declaration for a script no test imports', () => {
    // Membership is driven by imports, so a stale entry is a claim about a file
    // nothing exercises — and it would keep reading as covered.
    const imported = new Set([...scriptImportsByFile.values()].flat());
    for (const specifier of Object.keys(SCRIPT_SCOPE)) {
      expect(
        imported.has(specifier),
        `SCRIPT_SCOPE declares src/scripts/${specifier}, which no test imports — drop it ` +
        'rather than carrying a classification nothing checks',
      ).toBe(true);
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
