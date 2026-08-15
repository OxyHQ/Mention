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

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = join(packageRoot, "scripts", "coverage-policy.mjs");

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

/** Source files the fixture package contains, and how covered each one is. */
const FIXTURE_SOURCES = {
  // A critical path that clears the bar.
  "stores/keysStore.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
  // A critical path that does not, hence an exemption.
  "hooks/usePostLike.ts": { statements: 0, branches: 0, functions: 0, lines: 0 },
  // Ordinary domain files, pinned but not on the critical list.
  "services/plainService.ts": { statements: 60, branches: 50, functions: 40, lines: 61 },
  "utils/plainUtil.ts": { statements: 90, branches: 80, functions: 100, lines: 91 },
  // A web fork with no coverage: unenforceable, because jest resolves native.
  "lib/thing.web.ts": { statements: 0, branches: 0, functions: 0, lines: 0 },
  // A web fork a test imports by name, so it is pinned like anything else.
  "lib/other.web.ts": { statements: 70, branches: 60, functions: 50, lines: 71 },
};

const FIXTURE_PINS = {
  "stores/keysStore.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
  "hooks/usePostLike.ts": { statements: 0, branches: 0, functions: 0, lines: 0 },
  "services/plainService.ts": { statements: 60, branches: 50, functions: 40, lines: 61 },
  "utils/plainUtil.ts": { statements: 90, branches: 80, functions: 100, lines: 91 },
  "lib/other.web.ts": { statements: 70, branches: 60, functions: 50, lines: 71 },
};

const FIXTURE_TOTAL = { statements: 55, branches: 48, functions: 50, lines: 56 };

function basePolicy() {
  return {
    domains: [
      { id: "stores", why: "fixture", include: ["stores/**/*.ts"] },
      { id: "services", why: "fixture", include: ["services/**/*.ts"] },
      { id: "lib", why: "fixture", include: ["lib/**/*.ts"] },
      { id: "hooks", why: "fixture", include: ["hooks/**/*.ts"] },
      { id: "utils", why: "fixture", include: ["utils/**/*.ts"] },
    ],
    globalExcludes: ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx", "**/*.d.ts"],
    criticalPathBar: { statements: 80, branches: 65 },
    criticalPaths: {
      "react query cache keys and invalidation": ["stores/keysStore.ts"],
      "composer and post mutations": ["hooks/usePostLike.ts"],
    },
    belowBarExemptions: {
      "hooks/usePostLike.ts": { since: "2026-08-15", measured: "0%", reason: "fixture" },
    },
    unenforceable: { "lib/thing.web.ts": { reason: "fixture web fork" } },
    jestOwnedThresholds: {
      "./stores/keysStore.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
    allowedBaselineDecreases: [],
    globalDriftAllowancePoints: 0.75,
    minimumFilesInReport: 6,
    minimumTestFiles: 2,
    expectedCounts: {
      domainFiles: 6,
      pins: 5,
      unenforceable: 1,
      belowBarExemptions: 1,
      criticalPaths: 2,
      allowedBaselineDecreases: 0,
      snapshotAssertions: 0,
    },
  };
}

function baseBaselineFile() {
  const total = {};
  for (const [metric, pct] of Object.entries(FIXTURE_TOTAL)) {
    total[metric] = { pct, covered: pct, total: 100 };
  }
  return { total, pins: structuredClone(FIXTURE_PINS) };
}

/** The coverage-summary.json a run of the fixture's suite would produce. */
function baseReport(root, sources = FIXTURE_SOURCES) {
  const report = {};
  for (const [path, percentages] of Object.entries(sources)) {
    const entry = {};
    for (const [metric, pct] of Object.entries(percentages)) {
      entry[metric] = { pct, covered: pct, total: 100, skipped: 0 };
    }
    report[join(root, path)] = entry;
  }
  const total = {};
  for (const [metric, pct] of Object.entries(FIXTURE_TOTAL)) {
    total[metric] = { pct, covered: pct, total: 100, skipped: 0 };
  }
  report.total = total;
  return report;
}

function write(root, relativePath, contents) {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`);
}

/**
 * Build the fixture package, apply `mutate`, and run the real checker against
 * it. The fixture is a git repository with one commit so the base-revision
 * check has something real to read; `--base` names that commit.
 */
function runFixture(mutate) {
  const root = mkdtempSync(join(tmpdir(), "coverage-policy-"));
  try {
    const state = {
      policy: basePolicy(),
      baseline: baseBaselineFile(),
      report: baseReport(root),
      baseCommitBaseline: baseBaselineFile(),
      // Two test files, one of which the snapshot scan must be able to read.
      testFiles: {
        "utils/__tests__/plainUtil.test.ts": "it('works', () => expect(1).toBe(1));\n",
        "stores/__tests__/keysStore.test.ts": "it('works', () => expect(1).toBe(1));\n",
      },
      packageJson: {
        name: "fixture",
        jest: {
          coverageThreshold: {
            "./stores/keysStore.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
          },
        },
      },
      base: "HEAD",
    };
    mutate(state, root);

    for (const path of Object.keys(FIXTURE_SOURCES)) write(root, path, "export const x = 1;\n");
    for (const [path, body] of Object.entries(state.testFiles)) write(root, path, body);
    write(root, "package.json", state.packageJson);
    write(root, "coverage-policy.json", state.policy);
    write(root, "coverage/coverage-summary.json", state.report);

    // One commit holding the BASE baseline, then overwrite with the working one.
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "fixture");
    if (state.baseCommitBaseline !== null) {
      write(root, "coverage-baseline.json", state.baseCommitBaseline);
    }
    git("add", "-A");
    git("commit", "-qm", "fixture base");
    write(root, "coverage-baseline.json", state.baseline);

    const result = execFileSync(
      process.execPath,
      [checker, "--base", state.base],
      {
        cwd: root,
        env: { ...process.env, COVERAGE_POLICY_ROOT: root },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
      // execFileSync throws on a non-zero exit; caught below.
    );
    return { exitCode: 0, output: result };
  } catch (error) {
    if (error.status === undefined) throw error;
    return {
      exitCode: error.status,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Cases                                                               */
/* ------------------------------------------------------------------ */

const cases = [
  {
    name: "POSITIVE CONTROL — the unmutated fixture passes",
    mutate: () => {},
    expectFailure: false,
  },
  {
    name: "a pinned file losing coverage fails",
    mutate: (state, root) => {
      state.report[join(root, "utils/plainUtil.ts")].statements.pct = 89;
    },
    expectFailure: true,
    expectOutput: "lost coverage they had at the recorded baseline",
  },
  {
    name: "a critical-path file dropping under the bar fails",
    mutate: (state, root) => {
      state.report[join(root, "stores/keysStore.ts")].branches.pct = 64;
      state.baseline.pins["stores/keysStore.ts"].branches = 0;
      state.baseCommitBaseline.pins["stores/keysStore.ts"].branches = 0;
    },
    expectFailure: true,
    expectOutput: "critical-path file(s) are under the bar",
  },
  {
    name: "overall coverage falling below the baseline fails",
    mutate: (state) => {
      state.report.total.statements.pct = 54;
    },
    expectFailure: true,
    expectOutput: "Overall statements coverage fell to 54%",
  },
  {
    name: "overall coverage rising past the drift allowance demands a re-record",
    mutate: (state) => {
      state.report.total.statements.pct = 56;
    },
    expectFailure: true,
    expectOutput: "coverage:record",
  },
  {
    name: "a new unclassified domain file fails",
    mutate: (state, root) => {
      write(root, "services/brandNew.ts", "export const y = 2;\n");
      state.report[join(root, "services/brandNew.ts")] = baseReport(root, {
        "services/brandNew.ts": { statements: 0, branches: 0, functions: 0, lines: 0 },
      })[join(root, "services/brandNew.ts")];
      state.policy.expectedCounts.domainFiles = 7;
    },
    expectFailure: true,
    expectOutput: "classified nowhere",
  },
  {
    name: "lowering the baseline against the base revision fails",
    mutate: (state) => {
      state.baseline.pins["utils/plainUtil.ts"].statements = 10;
    },
    expectFailure: true,
    expectOutput: "lower than `HEAD`'s",
  },
  {
    name: "lowering the baseline TOTAL against the base revision fails",
    mutate: (state) => {
      state.baseline.total.statements.pct = 40;
      state.report.total.statements.pct = 40;
    },
    expectFailure: true,
    expectOutput: "baseline lowered from 55% to 40%",
  },
  {
    name: "a declared decrease excuses the lowering it names",
    mutate: (state) => {
      state.baseline.pins["utils/plainUtil.ts"].statements = 10;
      state.policy.allowedBaselineDecreases = [
        { path: "utils/plainUtil.ts", metric: "statements", date: "2026-08-15", reason: "fixture" },
      ];
      state.policy.expectedCounts.allowedBaselineDecreases = 1;
    },
    expectFailure: false,
  },
  {
    name: "a declared decrease that is not happening fails (the list cannot rot)",
    mutate: (state) => {
      state.policy.allowedBaselineDecreases = [
        { path: "utils/plainUtil.ts", metric: "statements", date: "2026-08-15", reason: "fixture" },
      ];
      state.policy.expectedCounts.allowedBaselineDecreases = 1;
    },
    expectFailure: true,
    expectOutput: "excuse a decrease that is not happening",
  },
  {
    name: "growing the exemption list without bumping the count fails",
    mutate: (state) => {
      state.policy.belowBarExemptions["services/plainService.ts"] = {
        since: "2026-08-15",
        measured: "60%",
        reason: "fixture",
      };
    },
    expectFailure: true,
    expectOutput: "expects 1 belowBarExemptions, found 2",
  },
  {
    name: "an exemption that now clears the bar must be removed",
    mutate: (state, root) => {
      state.report[join(root, "hooks/usePostLike.ts")] = baseReport(root, {
        "hooks/usePostLike.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
      })[join(root, "hooks/usePostLike.ts")];
    },
    expectFailure: true,
    expectOutput: "now clear the bar and must be removed",
  },
  {
    name: "an entry naming a file that no longer exists fails",
    mutate: (state) => {
      state.policy.belowBarExemptions["hooks/deleted.ts"] = {
        since: "2026-08-15",
        measured: "0%",
        reason: "fixture",
      };
      state.policy.expectedCounts.belowBarExemptions = 2;
    },
    expectFailure: true,
    expectOutput: "no such file",
  },
  {
    name: "lowering a jest-owned per-file threshold fails",
    mutate: (state) => {
      state.packageJson.jest.coverageThreshold["./stores/keysStore.ts"].branches = 90;
    },
    expectFailure: true,
    expectOutput: "was lowered",
  },
  {
    name: "deleting a jest-owned per-file threshold fails",
    mutate: (state) => {
      state.packageJson.jest.coverageThreshold = {};
    },
    expectFailure: true,
    expectOutput: "no longer declares a jest coverage threshold",
  },
  {
    name: "a snapshot assertion appearing in a test fails",
    mutate: (state) => {
      state.testFiles["utils/__tests__/plainUtil.test.ts"] =
        "it('renders', () => expect(tree).toMatchSnapshot());\n";
    },
    expectFailure: true,
    expectOutput: "assert against snapshots",
  },
  {
    name: "a covered web fork may not stay on the unenforceable list",
    mutate: (state, root) => {
      state.report[join(root, "lib/thing.web.ts")].statements.covered = 12;
      state.report[join(root, "lib/thing.web.ts")].statements.pct = 12;
    },
    expectFailure: true,
    expectOutput: "reachable from the suite",
  },
  {
    name: "an uncovered web fork may not be left unlisted",
    mutate: (state, root) => {
      state.report[join(root, "lib/other.web.ts")].statements.covered = 0;
      state.report[join(root, "lib/other.web.ts")].statements.pct = 0;
      state.baseline.pins["lib/other.web.ts"] = { statements: 0, branches: 0, functions: 0, lines: 0 };
      state.baseCommitBaseline.pins["lib/other.web.ts"] = { statements: 0, branches: 0, functions: 0, lines: 0 };
    },
    expectFailure: true,
    expectOutput: "must be listed in `unenforceable`",
  },
  {
    name: "an unparseable file dropping out of the report fails, even though it RAISES the percentages",
    mutate: (state, root) => {
      // Exactly what jest does with a syntax error in an uninstrumentable file:
      // it logs, exits 0, and the file leaves the denominator.
      delete state.report[join(root, "lib/thing.web.ts")];
      state.report.total.statements.pct = 55.4;
    },
    expectFailure: true,
    expectOutput: "missing from the coverage report",
  },
  {
    name: "a truncated coverage report cannot pass (report floor)",
    mutate: (state, root) => {
      for (const key of Object.keys(state.report)) {
        if (key !== "total" && key !== join(root, "stores/keysStore.ts")) delete state.report[key];
      }
    },
    expectFailure: true,
    expectOutput: "below the 6 floor",
  },
  {
    name: "a snapshot scan that reads nothing cannot pass (test-file floor)",
    mutate: (state) => {
      state.testFiles = {};
    },
    expectFailure: true,
    expectOutput: "below the 2 floor",
  },
  {
    name: "an unresolvable base revision fails rather than skipping",
    mutate: (state) => {
      state.base = "refs/heads/no-such-branch";
    },
    expectFailure: true,
    expectOutput: "does not resolve in this checkout",
  },
  {
    name: "a base revision that predates the baseline file is tolerated",
    mutate: (state) => {
      state.baseCommitBaseline = null;
    },
    expectFailure: false,
  },
  {
    name: "a glob the matcher does not understand throws instead of matching nothing",
    mutate: (state) => {
      state.policy.domains[0].include = ["stores/**/*.{ts,tsx}"];
    },
    expectFailure: true,
    expectOutput: "unsupported glob syntax",
  },
];

let failed = 0;
for (const testCase of cases) {
  const { exitCode, output } = runFixture(testCase.mutate);
  const didFail = exitCode !== 0;
  if (didFail !== testCase.expectFailure) {
    console.error(
      `FAIL ${testCase.name}: expected ${testCase.expectFailure ? "a failure" : "a pass"}, got exit ${exitCode}\n${output}`,
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
