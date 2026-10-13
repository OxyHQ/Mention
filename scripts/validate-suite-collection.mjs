#!/usr/bin/env node
/**
 * The suite must RUN what it claims to run.
 *
 * ## The failure this exists for
 *
 * A test file that dies before its first `it()` contributes ZERO tests. It does
 * not fail assertions — it has none to fail. So the pass RATIO improves:
 *
 *     502 files, 5610 collected, 5604 passed, 6 failed   →  99.9%
 *
 * while 32 files were dead at load and 296 declared tests never ran. Measured on
 * this repository, 2026-08-03. A gate that watches pass/fail cannot see it, and
 * the number it reports moves in the reassuring direction. That is what lets a
 * port be called done.
 *
 * ## What is asserted, and why it is structural rather than numeric
 *
 * A floor ("at least N tests") needs N maintained, and the first person to drop
 * a test legitimately will lower it — which is how the check dies. These two
 * invariants need no number and cannot rot:
 *
 *   1. **Every test file on disk appears in the report.** Catches a file the
 *      runner never picked up at all — a config `exclude` that grew, a scope
 *      narrowed by a stray CLI argument, a rename that no longer matches.
 *   2. **Every file in the report collects at least one test.** Catches the
 *      import-time death above.
 *
 * Total tests collected is printed as a SOFT signal and never fails the run, so
 * nobody is tempted to edit the hard check to make a number go away.
 *
 * ## Two runners, one suite
 *
 * While the backend moves from Vitest to `bun test`, a file is run by exactly
 * one of them (`packages/backend/testRunnerSplit.ts`). `bun test`'s results
 * arrive as JUnit XML (`--bun-junit`, one per shard) and are folded into the
 * Vitest report as ordinary entries, so both invariants above hold over the
 * UNION — a file neither runner reported is still missing. A third invariant
 * comes with the union:
 *
 *   3. **No file is reported twice.** Two runners (or two shards) that both
 *      claim a file would double its count and hide that the split broke.
 *
 * ## Skips are safe, and that was measured rather than assumed
 *
 * `it.skip` / `describe.skip` still COLLECT: vitest reports the cases with
 * status `skipped`, so such a file has `assertionResults.length > 0` and passes
 * invariant 2. A file with genuinely no `it()` at all fails, deliberately — a
 * `.test.ts` that declares nothing is either a mis-named helper or a file whose
 * cases were lost, and both are worth a red. Verified against a real report:
 * every one of the 32 zero-collecting files was a load failure, and no file in
 * the suite legitimately collects zero.
 *
 * Usage:  node scripts/validate-suite-collection.mjs <vitest-report.json> [testRoot]
 *            [--bun-cwd <dir> --bun-junit <junit.xml> [--bun-junit <junit.xml> …]]
 *
 * `--bun-cwd` is the directory `bun test` ran in: JUnit names files relative to it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Every `*.test.ts` under `root`, absolute, sorted. */
export function testFilesOnDisk(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.test.ts')) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (value) =>
  value.replace(/&(amp|lt|gt|quot|apos);/g, (_m, name) => XML_ENTITIES[name]);

/**
 * `bun test --reporter=junit` output as Vitest-report entries: one per test
 * FILE, with one assertion result per `<testcase>`. Cases are grouped by their
 * own `file` attribute rather than by `<testsuite>`, because Bun nests a
 * `<testsuite>` per `describe` and every level repeats the file. A file that
 * died at load has no `<testcase>` and no entry, so it surfaces as missing.
 *
 * @returns `{ results, numTotalTests }`
 */
export function bunJunitResults(xml, cwd) {
  const byFile = new Map();
  let numTotalTests = 0;
  for (const match of xml.matchAll(/<testcase\b([^>]*?)\/?>/g)) {
    const file = /\bfile="([^"]*)"/.exec(match[1]);
    if (!file) continue;
    const name = resolve(cwd, unescapeXml(file[1]));
    const caseName = /\bname="([^"]*)"/.exec(match[1]);
    if (!byFile.has(name)) byFile.set(name, []);
    byFile.get(name).push({ fullName: unescapeXml(caseName?.[1] ?? ''), status: 'reported' });
    numTotalTests += 1;
  }
  const results = [...byFile].map(([name, assertionResults]) => ({ name, assertionResults }));
  return { results, numTotalTests };
}

/** A Vitest report with `bun test` results appended to it, untouched otherwise. */
export function withBunResults(report, bun) {
  return {
    ...report,
    testResults: [
      ...(Array.isArray(report?.testResults) ? report.testResults : []),
      ...bun.results,
    ],
    numTotalTests: (report?.numTotalTests ?? 0) + bun.numTotalTests,
  };
}

/**
 * Compare a vitest JSON report against the files that exist.
 *
 * Pure, so the self-test can drive it with synthetic reports rather than by
 * breaking the real suite.
 *
 * @returns `{ ok, counts, missingFromReport, collectingZero }`
 */
export function validateCollection(report, filesOnDisk, mtimes = new Map(), cutoffOverride = null) {
  const results = Array.isArray(report?.testResults) ? report.testResults : [];
  // The cutoff is when the runner COLLECTED its file list — i.e. when the run
  // STARTED, not when the report was written. Using the report's mtime instead
  // misclassifies any file created mid-run as "never ran": measured here, a file
  // written 13 seconds after `startTime` but 32 seconds before the report landed
  // was reported as a real miss when it could not possibly have been collected.
  const reportMtime =
    cutoffOverride ?? (typeof report?.startTime === 'number' ? report.startTime : null);
  const reported = new Map();
  const reportedTwice = new Set();
  for (const file of results) {
    const path = resolve(file.name);
    if (reported.has(path)) reportedTwice.add(path);
    reported.set(path, file);
  }

  const absent = filesOnDisk.map((path) => resolve(path)).filter((path) => !reported.has(path));

  // A file WRITTEN AFTER this report was produced cannot possibly be in it, and
  // failing for that is definitionally wrong — it is also how a gate earns a
  // reputation for crying wolf and gets deleted by whoever hits it next. In a
  // repository where test files appear while a suite is running, this fires
  // constantly: measured on 2026-08-03, both invariant-1 hits were files created
  // 32 seconds and 18 minutes after the report finished. So it is separated out
  // and reported as STALENESS, not as a missing run.
  const missingCreatedAfterReport = [];
  const missingFromReport = [];
  for (const path of absent) {
    const mtime = mtimes.get(path);
    if (reportMtime !== null && mtime !== undefined && mtime > reportMtime) {
      missingCreatedAfterReport.push(path);
    } else {
      missingFromReport.push(path);
    }
  }

  const collectingZero = results
    .filter((file) => (file.assertionResults?.length ?? 0) === 0)
    .map((file) => file.name)
    .sort();

  return {
    ok: missingFromReport.length === 0 && collectingZero.length === 0 && reportedTwice.size === 0,
    counts: {
      filesOnDisk: filesOnDisk.length,
      filesInReport: results.length,
      filesCollectingZero: collectingZero.length,
      testsCollected: report?.numTotalTests ?? 0,
    },
    missingFromReport,
    missingCreatedAfterReport,
    collectingZero,
    reportedTwice: [...reportedTwice].sort(),
  };
}

/** Human-readable verdict. Returns the exit code. */
export function report(result, log = console.log) {
  const { counts } = result;
  log(`  test files on disk        : ${counts.filesOnDisk}`);
  log(`  test files in the report  : ${counts.filesInReport}`);
  log(`  files collecting ZERO     : ${counts.filesCollectingZero}`);
  log(`  tests collected (soft)    : ${counts.testsCollected}`);

  if (result.missingCreatedAfterReport?.length > 0) {
    log('');
    log('note — these test files were written AFTER this report and so could not be in it.');
    log('       Not a failure; re-run the suite if you want them measured.');
    for (const path of result.missingCreatedAfterReport) log(`       ${path}`);
  }

  if (result.missingFromReport.length > 0) {
    log('');
    log('FAIL — these test files exist on disk but the runner never reported them.');
    log('       They were not run, and nothing about the pass ratio would show it.');
    log('');
    log('       TWO causes, and the fix differs:');
    log('         1. the file died before collection — look for an import-time error;');
    log("         2. the runner's `include` does not cover it — look at the config.");
    log('       vitest collects `src/__tests__/**/*.test.ts`; this walk is WIDER on');
    log('       purpose, so a colocated `src/foo/bar.test.ts` that never runs is');
    log('       still caught rather than silently ignored.');
    for (const path of result.missingFromReport) log(`       ${path}`);
  }

  if (result.collectingZero.length > 0) {
    log('');
    log('FAIL — these files were reported but collected ZERO tests.');
    log('       A file that dies before its first `it()` has no assertions to fail,');
    log('       so the pass ratio IMPROVES. Fix the import-time error, or delete the file.');
    for (const path of result.collectingZero) log(`       ${path}`);
  }

  if (result.reportedTwice?.length > 0) {
    log('');
    log('FAIL — these files were reported MORE THAN ONCE: by both Vitest and `bun test`, or by');
    log('       two shards. Each file must belong to exactly one runner — see');
    log('       packages/backend/testRunnerSplit.ts.');
    for (const path of result.reportedTwice) log(`       ${path}`);
  }

  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const positional = [];
  const bunJunitPaths = [];
  let bunCwd = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--bun-junit') bunJunitPaths.push(args[++i]);
    else if (args[i] === '--bun-cwd') bunCwd = args[++i];
    else positional.push(args[i]);
  }
  const [reportPath, testRoot = 'packages/backend/src'] = positional;
  if (!reportPath || (bunJunitPaths.length > 0 && !bunCwd) || bunJunitPaths.includes(undefined)) {
    console.error(
      'usage: validate-suite-collection.mjs <vitest-report.json> [testRoot] ' +
        '[--bun-cwd <dir> --bun-junit <junit.xml> ...]',
    );
    process.exit(2);
  }
  let parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
  for (const junitPath of bunJunitPaths) {
    parsed = withBunResults(
      parsed,
      bunJunitResults(readFileSync(junitPath, 'utf8'), resolve(bunCwd)),
    );
  }
  const files = testFilesOnDisk(resolve(testRoot));
  const mtimes = new Map(files.map((path) => [resolve(path), statSync(path).mtimeMs]));
  // No cutoff override: `report.startTime` is the right one. The report's own
  // mtime is the END of the run and would misclassify a file created mid-run.
  const result = validateCollection(parsed, files, mtimes);
  console.log('Suite collection:');
  process.exit(report(result));
}
