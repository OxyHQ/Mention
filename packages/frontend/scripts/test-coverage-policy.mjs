#!/usr/bin/env node

/**
 * Mutation-tests `coverage-policy.mjs`.
 *
 * A coverage gate that has never been seen to fail is indistinguishable from no
 * gate, and the failure mode is silent by construction: everything is green
 * either way. So each case below breaks exactly one thing the policy claims to
 * measure and requires the checker to go red, and to say WHY in words the person
 * who hit it can act on.
 *
 * The fixture is a synthetic package rather than this one. Running against the
 * real tree would make every case depend on the real suite's numbers, and a
 * case that stops firing because coverage moved is a case that has quietly
 * stopped measuring anything. The first case is the positive control: the same
 * fixture, unmutated, must PASS — without it every "it failed" below could be
 * the fixture itself being malformed.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(packageRoot, 'scripts', 'coverage-policy.mjs');

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Source files the fixture package contains, and how covered each one is. Every
 * metric has 100 items, so a percentage here is also the covered count and
 * `100 - pct` is the uncovered count the baseline pins.
 */
const FIXTURE_SOURCES = {
  // A critical path that clears the bar.
  'stores/keysStore.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
  // A critical path that does not, hence an exemption.
  'hooks/usePostLike.ts': { statements: 0, branches: 0, functions: 0, lines: 0 },
  // Ordinary domain files, pinned but not on the critical list.
  'services/plainService.ts': { statements: 60, branches: 50, functions: 40, lines: 61 },
  'utils/plainUtil.ts': { statements: 90, branches: 80, functions: 100, lines: 91 },
  // A web fork with no coverage: unenforceable, because jest resolves native.
  'lib/thing.web.ts': { statements: 0, branches: 0, functions: 0, lines: 0 },
  // A web fork a test imports by name, so it is pinned like anything else.
  'lib/other.web.ts': { statements: 70, branches: 60, functions: 50, lines: 71 },
};

const PINNED = [
  'stores/keysStore.ts',
  'hooks/usePostLike.ts',
  'services/plainService.ts',
  'utils/plainUtil.ts',
  'lib/other.web.ts',
];

/** A report entry for coverage given as `{ metric: pct-of-100 }`. */
function entryFrom(percentages) {
  const entry = {};
  for (const [metric, pct] of Object.entries(percentages)) {
    entry[metric] = { pct, covered: pct, total: 100, skipped: 0 };
  }
  return entry;
}

/** Overwrite one metric of a report entry with an exact covered/total pair. */
function setMetric(entry, metric, covered, total) {
  entry[metric] = {
    pct: total === 0 ? 100 : Math.round((covered / total) * 10000) / 100,
    covered,
    total,
    skipped: 0,
  };
}

/** The `total` entry jest would write: the sum of every file entry. */
function totalOf(report) {
  const total = {};
  for (const metric of ['statements', 'branches', 'functions', 'lines']) {
    let covered = 0;
    let items = 0;
    for (const [key, entry] of Object.entries(report)) {
      if (key === 'total') continue;
      covered += entry[metric].covered;
      items += entry[metric].total;
    }
    setMetric(total, metric, covered, items);
  }
  return total;
}

function basePolicy() {
  return {
    domains: [
      { id: 'stores', why: 'fixture', include: ['stores/**/*.ts'] },
      { id: 'services', why: 'fixture', include: ['services/**/*.ts'] },
      { id: 'lib', why: 'fixture', include: ['lib/**/*.ts'] },
      { id: 'hooks', why: 'fixture', include: ['hooks/**/*.ts'] },
      { id: 'utils', why: 'fixture', include: ['utils/**/*.ts'] },
    ],
    globalExcludes: ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx', '**/*.d.ts'],
    criticalPathBar: { statements: 80, branches: 65 },
    criticalPaths: {
      'react query cache keys and invalidation': ['stores/keysStore.ts'],
      'composer and post mutations': ['hooks/usePostLike.ts'],
    },
    belowBarExemptions: {
      'hooks/usePostLike.ts': { since: '2026-08-15', measured: '0%', reason: 'fixture' },
    },
    unenforceable: { 'lib/thing.web.ts': { reason: 'fixture web fork' } },
    jestOwnedThresholds: {
      './stores/keysStore.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
    allowedBaselineRelaxations: [],
    uncoveredSlackAllowance: { statements: 2, branches: 2, functions: 2, lines: 2 },
    minimumFilesInReport: 6,
    minimumTestFiles: 2,
    expectedCounts: {
      unenforceable: 1,
      belowBarExemptions: 1,
      criticalPaths: 2,
      snapshotAssertions: 0,
    },
  };
}

/**
 * The recorded baseline for the unmutated fixture, as `coverage:record` would
 * write it. Totals: statements 320/600, branches 290/600, functions 290/600,
 * lines 323/600 — so added code may be uncovered at 280/600 of statements.
 */
function baseBaselineFile() {
  const report = baseReport('/fixture');
  const counts = (entry) =>
    Object.fromEntries(Object.entries(entry).map(([metric, m]) => [metric, [m.covered, m.total]]));
  const pins = {};
  for (const path of PINNED) pins[path] = counts(entryFrom(FIXTURE_SOURCES[path]));
  const sizes = {};
  for (const path of Object.keys(FIXTURE_SOURCES).sort()) sizes[path] = [100, 100, 100, 100];
  return { schemaVersion: 2, total: counts(report.total), pins, sizes };
}

/** The same fixture as a schema-1 (percentage) baseline, as main held before. */
function percentageBaselineFile() {
  const report = baseReport('/fixture');
  const total = {};
  for (const [metric, m] of Object.entries(report.total)) {
    total[metric] = { pct: m.pct, covered: m.covered, total: m.total };
  }
  const pins = {};
  for (const path of PINNED) pins[path] = { ...FIXTURE_SOURCES[path] };
  return { total, pins };
}

/** The coverage-summary.json a run of the fixture's suite would produce. */
function baseReport(root, sources = FIXTURE_SOURCES) {
  const report = {};
  for (const [path, percentages] of Object.entries(sources)) {
    report[join(root, path)] = entryFrom(percentages);
  }
  report.total = totalOf(report);
  return report;
}

function write(root, relativePath, contents) {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(
    full,
    typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`,
  );
}

/**
 * Build the fixture package, apply `mutate`, and run the real checker against
 * it. The fixture is a git repository with one commit so the base-revision
 * check has something real to read; `--base` names that commit.
 */
function runFixture(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'coverage-policy-'));
  try {
    const state = {
      policy: basePolicy(),
      baseline: baseBaselineFile(),
      report: baseReport(root),
      baseCommitBaseline: baseBaselineFile(),
      baseCommitPolicy: basePolicy(),
      // Two test files, one of which the snapshot scan must be able to read.
      testFiles: {
        'utils/__tests__/plainUtil.test.ts': "it('works', () => expect(1).toBe(1));\n",
        'stores/__tests__/keysStore.test.ts': "it('works', () => expect(1).toBe(1));\n",
      },
      packageJson: {
        name: 'fixture',
        jest: {
          coverageThreshold: {
            './stores/keysStore.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
          },
        },
      },
      base: 'HEAD',
      env: {},
    };
    mutate(state, root);
    // jest's total is the sum of its files, so a case mutates files and the
    // total follows — exactly as it would in a real run.
    state.report.total = totalOf(state.report);

    for (const path of Object.keys(FIXTURE_SOURCES)) write(root, path, 'export const x = 1;\n');
    for (const [path, body] of Object.entries(state.testFiles)) write(root, path, body);
    write(root, 'package.json', state.packageJson);
    write(root, 'coverage/coverage-summary.json', state.report);

    // One commit holding the BASE policy and baseline, then overwrite both with
    // the working ones.
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'fixture');
    write(root, 'coverage-policy.json', state.baseCommitPolicy);
    if (state.baseCommitBaseline !== null) {
      write(root, 'coverage-baseline.json', state.baseCommitBaseline);
    }
    git('add', '-A');
    git('commit', '-qm', 'fixture base');
    write(root, 'coverage-policy.json', state.policy);
    write(root, 'coverage-baseline.json', state.baseline);

    // spawnSync rather than execFileSync: a passing run's stderr (where the
    // advisory warnings go) has to reach the assertions too.
    const result = spawnSync(process.execPath, [checker, '--base', state.base], {
      cwd: root,
      env: {
        ...process.env,
        COVERAGE_POLICY_STALE_BASELINE: '',
        ...state.env,
        COVERAGE_POLICY_ROOT: root,
      },
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    return { exitCode: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Cases                                                               */
/* ------------------------------------------------------------------ */

const cases = [
  {
    name: 'POSITIVE CONTROL — the unmutated fixture passes',
    mutate: () => {},
    expectFailure: false,
  },
  {
    name: 'a pinned file losing coverage fails',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'utils/plainUtil.ts')], 'statements', 89, 100);
    },
    expectFailure: true,
    expectOutput: 'utils/plainUtil.ts: 11 uncovered statements, at most 10 allowed',
  },
  {
    name: 'a critical-path file dropping under the bar fails',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'stores/keysStore.ts')], 'branches', 64, 100);
    },
    expectFailure: true,
    expectOutput: 'critical-path file(s) are under the bar',
  },
  {
    // An unpinned file, so only the overall rule can see it: 1 statement added,
    // 280/600 of which may be uncovered, is 0.47 of an item.
    name: 'adding an uncovered statement anywhere fails overall',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'lib/thing.web.ts')], 'statements', 0, 101);
    },
    expectFailure: true,
    expectOutput: 'Overall statements: 281 uncovered, at most 280 allowed',
  },
  {
    // The #1814 shape: tested code deleted. Every ratio under 100% falls —
    // plainService functions 40% -> 39.39%, under its old floored pin of 40 —
    // yet nothing became less tested, so nothing may fail.
    name: 'deleting tested code passes, though every percentage falls',
    mutate: (state, root) => {
      const service = state.report[join(root, 'services/plainService.ts')];
      setMetric(service, 'functions', 39, 99);
      setMetric(service, 'statements', 50, 90);
      setMetric(service, 'lines', 51, 90);
    },
    expectFailure: false,
  },
  {
    // plainService is 60/100: 10 statements added with 6 covered is exactly its
    // own rate, and better than the 320/600 overall.
    name: 'adding code covered at least as well as the average passes',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'services/plainService.ts')], 'statements', 66, 110);
    },
    expectFailure: false,
  },
  {
    name: 'adding code covered worse than the average fails',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'services/plainService.ts')], 'statements', 65, 110);
    },
    expectFailure: true,
    expectOutput: 'services/plainService.ts: 45 uncovered statements, at most 44 allowed',
  },
  {
    name: 'adding a function no test calls fails',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'services/plainService.ts')], 'functions', 40, 101);
    },
    expectFailure: true,
    expectOutput: 'services/plainService.ts: 61 uncovered functions, at most 60 allowed',
  },
  {
    // The merge-queue tree main + A + B, where each passes alone: additions at
    // or above the average sum to an addition at or above the average.
    name: 'two changes that each add code at the average pass together',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'services/plainService.ts')], 'statements', 66, 110);
      setMetric(state.report[join(root, 'utils/plainUtil.ts')], 'statements', 99, 110);
      // A queue run: what the pair banks above the average is advisory there.
      state.env.COVERAGE_POLICY_STALE_BASELINE = 'warn';
    },
    expectFailure: false,
  },
  {
    name: 'two changes that each add code below the average fail together',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'services/plainService.ts')], 'statements', 65, 110);
      setMetric(state.report[join(root, 'utils/plainUtil.ts')], 'statements', 98, 110);
    },
    expectFailure: true,
    expectOutput: 'Overall statements:',
  },
  {
    // A deletes 10 tested statements from plainService; B adds 10 to plainUtil
    // at its own rate. The NET total did not grow, so a net-growth rule would
    // allow B nothing and fail the pair it passed one at a time. Growth is
    // summed per file, so a deletion never cancels an addition elsewhere.
    name: 'a deletion queued with an addition at the average passes together',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'services/plainService.ts')], 'statements', 50, 90);
      setMetric(state.report[join(root, 'utils/plainUtil.ts')], 'statements', 99, 110);
      // A queue run: what the pair banks above the average is advisory there.
      state.env.COVERAGE_POLICY_STALE_BASELINE = 'warn';
    },
    expectFailure: false,
  },
  {
    // main grew since the baseline: usePostLike gained 20 statements, 9 of them
    // uncovered, which the allowance (280/600 of 20 = 9.33) just covers.
    // Deleting tested code from another file must still pass — under a
    // net-growth rule the deletion would shrink the allowance main already
    // spent, and fail.
    name: 'deleting tested code passes after the code grew since the baseline',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'hooks/usePostLike.ts')], 'statements', 11, 120);
      setMetric(state.report[join(root, 'services/plainService.ts')], 'statements', 50, 90);
    },
    expectFailure: false,
  },
  {
    name: 'banked slack past the allowance demands a re-anchor',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'services/plainService.ts')], 'statements', 63, 100);
    },
    expectFailure: true,
    expectOutput: 'coverage:record -- --refresh',
  },
  {
    name: 'banked slack inside the allowance passes without a re-record',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'services/plainService.ts')], 'statements', 62, 100);
    },
    expectFailure: false,
  },
  {
    name: 'a stale baseline is only a warning outside a pull request (merge queue)',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'services/plainService.ts')], 'statements', 63, 100);
      state.env.COVERAGE_POLICY_STALE_BASELINE = 'warn';
    },
    expectFailure: false,
    expectOutput: 'Coverage policy warning (advisory here)',
  },
  {
    name: 'a new unclassified domain file fails',
    mutate: (state, root) => {
      write(root, 'services/brandNew.ts', 'export const y = 2;\n');
      state.report[join(root, 'services/brandNew.ts')] = entryFrom({
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
      });
    },
    expectFailure: true,
    expectOutput: 'classified nowhere',
  },
  {
    name: 'a schema-1 working baseline is refused, not misread as counts',
    mutate: (state) => {
      state.baseline = percentageBaselineFile();
    },
    expectFailure: true,
    expectOutput: 'this script reads schema 2',
  },
  {
    name: 'relaxing a pin against the base revision fails',
    mutate: (state) => {
      state.baseline.pins['utils/plainUtil.ts'].statements = [50, 100];
    },
    expectFailure: true,
    expectOutput: "looser than `HEAD`'s",
  },
  {
    name: 'relaxing the baseline TOTAL against the base revision fails',
    mutate: (state) => {
      state.baseline.total.statements = [200, 600];
    },
    expectFailure: true,
    expectOutput: 'total statements: recorded 200/600 covered, which 320/600 does not allow',
  },
  {
    name: 'migrating from a schema-1 base passes when the counts match its percentages',
    mutate: (state) => {
      state.baseCommitBaseline = percentageBaselineFile();
    },
    expectFailure: false,
  },
  {
    name: 'migrating from a schema-1 base cannot record less than its percentages required',
    mutate: (state) => {
      state.baseCommitBaseline = percentageBaselineFile();
      state.baseline.pins['utils/plainUtil.ts'].statements = [89, 100];
    },
    expectFailure: true,
    expectOutput: 'statements pin recorded at 89/100 covered, which 90/100 does not allow',
  },
  {
    name: 'a declared relaxation excuses the relaxation it names',
    mutate: (state) => {
      state.baseline.pins['utils/plainUtil.ts'].statements = [50, 100];
      state.policy.allowedBaselineRelaxations = [
        { path: 'utils/plainUtil.ts', metric: 'statements', date: '2026-08-15', reason: 'fixture' },
      ];
    },
    expectFailure: false,
  },
  {
    name: 'an added allowance that is not happening fails (the list cannot rot)',
    mutate: (state) => {
      state.policy.allowedBaselineRelaxations = [
        { path: 'utils/plainUtil.ts', metric: 'statements', date: '2026-08-15', reason: 'fixture' },
      ];
    },
    expectFailure: true,
    expectOutput: 'excuse a relaxation that is not happening',
  },
  {
    name: 'an allowance inherited from the base excuses nothing',
    mutate: (state) => {
      state.baseline.pins['utils/plainUtil.ts'].statements = [50, 100];
      state.policy.allowedBaselineRelaxations = [
        { path: 'utils/plainUtil.ts', metric: 'statements', date: '2026-08-15', reason: 'fixture' },
      ];
      state.baseCommitPolicy.allowedBaselineRelaxations = state.policy.allowedBaselineRelaxations;
    },
    expectFailure: true,
    expectOutput: "looser than `HEAD`'s",
  },
  {
    name: 'an allowance inherited from the base is not reported as unused',
    mutate: (state) => {
      state.policy.allowedBaselineRelaxations = [
        { path: 'utils/plainUtil.ts', metric: 'statements', date: '2026-08-15', reason: 'fixture' },
      ];
      state.baseCommitPolicy.allowedBaselineRelaxations = state.policy.allowedBaselineRelaxations;
    },
    expectFailure: false,
  },
  {
    name: 'growing the exemption list without bumping the count fails',
    mutate: (state) => {
      state.policy.belowBarExemptions['services/plainService.ts'] = {
        since: '2026-08-15',
        measured: '60%',
        reason: 'fixture',
      };
    },
    expectFailure: true,
    expectOutput: 'expects 1 belowBarExemptions, found 2',
  },
  {
    name: 'an exemption that now clears the bar must be removed',
    mutate: (state, root) => {
      state.report[join(root, 'hooks/usePostLike.ts')] = entryFrom({
        statements: 95,
        branches: 90,
        functions: 90,
        lines: 95,
      });
    },
    expectFailure: true,
    expectOutput: 'now clear the bar and must be removed',
  },
  {
    name: 'an entry naming a file that no longer exists fails',
    mutate: (state) => {
      state.policy.belowBarExemptions['hooks/deleted.ts'] = {
        since: '2026-08-15',
        measured: '0%',
        reason: 'fixture',
      };
      state.policy.expectedCounts.belowBarExemptions = 2;
    },
    expectFailure: true,
    expectOutput: 'no such file',
  },
  {
    name: 'lowering a jest-owned per-file threshold fails',
    mutate: (state) => {
      state.packageJson.jest.coverageThreshold['./stores/keysStore.ts'].branches = 90;
    },
    expectFailure: true,
    expectOutput: 'was lowered',
  },
  {
    name: 'deleting a jest-owned per-file threshold fails',
    mutate: (state) => {
      state.packageJson.jest.coverageThreshold = {};
    },
    expectFailure: true,
    expectOutput: 'no longer declares a jest coverage threshold',
  },
  {
    name: 'a snapshot assertion appearing in a test fails',
    mutate: (state) => {
      state.testFiles['utils/__tests__/plainUtil.test.ts'] =
        "it('renders', () => expect(tree).toMatchSnapshot());\n";
    },
    expectFailure: true,
    expectOutput: 'assert against snapshots',
  },
  {
    name: 'a covered web fork may not stay on the unenforceable list',
    mutate: (state, root) => {
      state.report[join(root, 'lib/thing.web.ts')].statements.covered = 12;
      state.report[join(root, 'lib/thing.web.ts')].statements.pct = 12;
    },
    expectFailure: true,
    expectOutput: 'reachable from the suite',
  },
  {
    name: 'an uncovered web fork may not be left unlisted',
    mutate: (state, root) => {
      setMetric(state.report[join(root, 'lib/other.web.ts')], 'statements', 0, 100);
    },
    expectFailure: true,
    expectOutput: 'must be listed in `unenforceable`',
  },
  {
    name: 'an unparseable file dropping out of the report fails, even though it LOWERS the uncovered count',
    mutate: (state, root) => {
      // Exactly what jest does with a syntax error in an uninstrumentable file:
      // it logs, exits 0, and the file — with its uncovered items — leaves the
      // report, which every count-based check reads as an improvement.
      delete state.report[join(root, 'lib/thing.web.ts')];
    },
    expectFailure: true,
    expectOutput: 'missing from the coverage report',
  },
  {
    name: 'a truncated coverage report cannot pass (report floor)',
    mutate: (state, root) => {
      for (const key of Object.keys(state.report)) {
        if (key !== 'total' && key !== join(root, 'stores/keysStore.ts')) delete state.report[key];
      }
    },
    expectFailure: true,
    expectOutput: 'below the 6 floor',
  },
  {
    name: 'a snapshot scan that reads nothing cannot pass (test-file floor)',
    mutate: (state) => {
      state.testFiles = {};
    },
    expectFailure: true,
    expectOutput: 'below the 2 floor',
  },
  {
    name: 'an unresolvable base revision fails rather than skipping',
    mutate: (state) => {
      state.base = 'refs/heads/no-such-branch';
    },
    expectFailure: true,
    expectOutput: 'does not resolve in this checkout',
  },
  {
    name: 'a base revision that predates the baseline file is tolerated',
    mutate: (state) => {
      state.baseCommitBaseline = null;
    },
    expectFailure: false,
  },
  {
    name: 'a glob the matcher does not understand throws instead of matching nothing',
    mutate: (state) => {
      state.policy.domains[0].include = ['stores/**/*.{ts,tsx}'];
    },
    expectFailure: true,
    expectOutput: 'unsupported glob syntax',
  },
];

let failed = 0;
for (const testCase of cases) {
  const { exitCode, output } = runFixture(testCase.mutate);
  const didFail = exitCode !== 0;
  if (didFail !== testCase.expectFailure) {
    console.error(
      `FAIL ${testCase.name}: expected ${testCase.expectFailure ? 'a failure' : 'a pass'}, got exit ${exitCode}\n${output}`,
    );
    failed += 1;
    continue;
  }
  if (testCase.expectOutput && !output.includes(testCase.expectOutput)) {
    console.error(
      `FAIL ${testCase.name}: failed as expected, but never said "${testCase.expectOutput}"\n${output}`,
    );
    failed += 1;
    continue;
  }
  console.log(`ok   ${testCase.name}`);
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} coverage-policy cases failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} coverage-policy cases passed.`);
