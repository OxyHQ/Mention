#!/usr/bin/env node

/**
 * The frontend coverage policy: a critical-path floor plus a no-regression
 * ratchet, evaluated against the report `test:coverage` just produced.
 *
 * WHY THIS EXISTS RATHER THAN A HIGHER `global` NUMBER IN package.json
 *
 * A global percentage is satisfied by whatever is cheapest to cover, which is
 * never the code that matters. Measured on `c96c2764`: the declared global floor
 * was 14.86% statements while the suite actually produced 28.34% — 13.5 points
 * of slack, enough to delete every test in `stores/` and `services/` and still
 * report green. A floor that far under the measurement is not a floor.
 *
 * So the policy names the code instead:
 *
 *   1. DOMAINS are globs over the behavioural-logic tree (stores, services, lib,
 *      db, providers, post-mutation hooks). Every file a domain glob matches
 *      must be classified — pinned, or written down as unenforceable with a
 *      reason. A file in neither FAILS. That is the half a hand-maintained list
 *      cannot do: a new service lands already inside the gate.
 *   2. PINS are the measured per-file coverage of every classified file, floored
 *      to whole points. They only fire downwards, so they cost nothing to carry
 *      and catch the one thing a global number hides — a single critical file
 *      losing its tests while the aggregate is propped up elsewhere.
 *   3. The CRITICAL-PATH BAR applies to the seven areas issue #700 names. A file
 *      there must clear the bar or appear in `belowBarExemptions` with a reason.
 *      The exemption list carries an EXACT count, so it cannot grow one
 *      defensible line at a time.
 *   4. The RATCHET compares the whole-report totals against the recorded
 *      baseline. Below it fails. More than `globalDriftAllowancePoints` above it
 *      also fails, telling you to re-record — without that, coverage can climb
 *      to 40% and silently fall back to the day the baseline was written.
 *   5. The baseline file itself may not DECREASE against the base revision. This
 *      is what stops the obvious escape: re-recording a lower baseline in the
 *      same pull request that removed the tests.
 *
 * Every check below is paired with the question "what would this report if the
 * thing it measures were absent?" — `scripts/test-coverage-policy.mjs` mutates
 * each one and requires it to go red.
 *
 * Usage:
 *   node scripts/coverage-policy.mjs [--coverage-dir <dir>] [--base <git-rev>]
 *   node scripts/coverage-policy.mjs --record [--coverage-dir <dir>]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = process.env.COVERAGE_POLICY_ROOT
  ? resolve(process.env.COVERAGE_POLICY_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

const POLICY_PATH = join(packageRoot, "coverage-policy.json");
const BASELINE_PATH = join(packageRoot, "coverage-baseline.json");
const METRICS = ["statements", "branches", "functions", "lines"];

/** How to get back here from a laptop. Printed with every failure. */
const REPRO =
  "reproduce locally:\n"
  + "    bun run --cwd packages/frontend test:coverage\n"
  + "    bun run --cwd packages/frontend coverage:check";

function parseArguments(argv) {
  const options = { record: false, coverageDir: "coverage", base: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--record") options.record = true;
    else if (argument === "--coverage-dir") options.coverageDir = argv[++index];
    else if (argument === "--base") options.base = argv[++index];
    else throw new Error(`unrecognised argument: ${argument}`);
  }
  return options;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * A glob matcher for the shapes the policy file is allowed to use: `**` spans
 * directories, `*` does not, everything else is literal. Deliberately small —
 * an unsupported construct must THROW rather than silently match nothing, which
 * is how a glob typo turns a domain into an empty set and the gate into a
 * formality.
 */
function globToRegExp(pattern) {
  if (/[?[\]{}()!+@]/.test(pattern)) {
    throw new Error(
      `coverage-policy.json: unsupported glob syntax in "${pattern}" — `
      + "only `**`, `*` and literal path segments are understood",
    );
  }
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        // `dir/**/x` must also match `dir/x`, so the slash is optional.
        if (pattern[index + 2] === "/") {
          source += "(?:[^/]+/)*";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += character.replace(/[.^$\\|]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/** Every source file under the package, as paths relative to the package root. */
function collectSourceFiles(directory, collected) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    const relativePath = relative(packageRoot, full);
    if (
      entry.isDirectory()
      && /^(?:node_modules|android|ios|dist|\.expo|coverage|assets|locales|public)$/.test(entry.name)
    ) {
      continue;
    }
    if (entry.isDirectory()) collectSourceFiles(full, collected);
    else if (/\.tsx?$/.test(entry.name)) collected.push(relativePath);
  }
  return collected;
}

/** Coverage percentages for one file, or `null` when the report omits it. */
function percentagesFor(report, relativePath) {
  const entry = report[join(packageRoot, relativePath)];
  if (!entry) return null;
  const percentages = {};
  for (const metric of METRICS) percentages[metric] = entry[metric].pct;
  return percentages;
}

function pinFrom(percentages) {
  const pin = {};
  for (const metric of METRICS) pin[metric] = Math.floor(percentages[metric]);
  return pin;
}

/* ------------------------------------------------------------------ */
/* Load                                                                */
/* ------------------------------------------------------------------ */

const options = parseArguments(process.argv.slice(2));
const policy = readJson(POLICY_PATH);
const summaryPath = resolve(packageRoot, options.coverageDir, "coverage-summary.json");

if (!existsSync(summaryPath)) {
  console.error(
    `Coverage policy: no report at ${summaryPath}.\n`
    + "  The policy is evaluated against the report `test:coverage` writes; without\n"
    + "  one there is nothing to measure and a pass would mean nothing.\n"
    + `  ${REPRO}`,
  );
  process.exit(1);
}

const report = readJson(summaryPath);
const reportedFiles = Object.keys(report).filter((key) => key !== "total");

const everySourceFile = collectSourceFiles(packageRoot, []);
const allSourceFiles = everySourceFile.filter(
  (path) => !matchesAny(path, policy.globalExcludes),
);
const testFiles = everySourceFile.filter((path) => /\.test\.tsx?$/.test(path));
const snapshotUsers = testFiles.filter((path) =>
  /toMatch(?:Inline)?Snapshot\s*\(/.test(readFileSync(join(packageRoot, path), "utf8")),
);

/** Domain membership: path -> the id of the first domain that claims it. */
const domainOf = new Map();
for (const domain of policy.domains) {
  for (const path of allSourceFiles) {
    if (domainOf.has(path)) continue;
    if (!matchesAny(path, domain.include)) continue;
    if (domain.exclude && matchesAny(path, domain.exclude)) continue;
    domainOf.set(path, domain.id);
  }
}
const domainFiles = [...domainOf.keys()].sort();

/* ------------------------------------------------------------------ */
/* Record                                                              */
/* ------------------------------------------------------------------ */

if (options.record) {
  const pins = {};
  const missing = [];
  for (const path of domainFiles) {
    if (policy.unenforceable[path]) continue;
    const percentages = percentagesFor(report, path);
    if (!percentages) {
      missing.push(path);
      continue;
    }
    pins[path] = pinFrom(percentages);
  }
  if (missing.length > 0) {
    console.error(
      "Coverage policy: cannot record — the report omits domain files, so the\n"
      + "  baseline would silently stop covering them:\n"
      + missing.map((path) => `    ${path}`).join("\n"),
    );
    process.exit(1);
  }
  const total = {};
  for (const metric of METRICS) {
    total[metric] = {
      pct: report.total[metric].pct,
      covered: report.total[metric].covered,
      total: report.total[metric].total,
    };
  }
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        $comment:
          "Machine-recorded by `bun run --cwd packages/frontend coverage:record`. "
          + "Do not hand-edit: a lowered number here is a lowered gate, and "
          + "coverage-policy.json's base-revision check refuses one that is not "
          + "listed in allowedBaselineDecreases.",
        total,
        pins,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Coverage baseline recorded: ${Object.keys(pins).length} pinned files, `
    + `${total.statements.pct}% statements overall.`,
  );
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* Check                                                               */
/* ------------------------------------------------------------------ */

const baseline = readJson(BASELINE_PATH);
const failures = [];
const fail = (headline, detail) => failures.push(`${headline}\n${detail}`);

/*
 * 1. The report has to be a real one.
 *
 * Absent-check: a truncated report, or one written by a run that collapsed
 * after two suites, produces exactly the coverage numbers of a codebase with
 * no code — and every ratchet below would read that as an improvement.
 */
if (reportedFiles.length < policy.minimumFilesInReport) {
  fail(
    `Coverage report holds ${reportedFiles.length} files, below the ${policy.minimumFilesInReport} floor.`,
    "  A short report is what a collapsed run looks like, and every check below\n"
    + "  would read it as an improvement rather than a failure.\n"
    + `  ${REPRO}`,
  );
}

/*
 * 2. Classification completeness.
 *
 * Absent-check: without this, adding `services/newThing.ts` with no tests moves
 * the global number by a rounding error and nothing else — which is the exact
 * hole issue #700 opens with.
 */
const unclassified = domainFiles.filter(
  (path) => !baseline.pins[path] && !policy.unenforceable[path],
);
if (unclassified.length > 0) {
  fail(
    `${unclassified.length} behavioural-logic file(s) are inside a coverage domain but classified nowhere:`,
    `${unclassified.map((path) => `    ${path}  (domain: ${domainOf.get(path)})`).join("\n")}\n`
    + "  Cover it and record the pin, or add it to `unenforceable` in\n"
    + "  coverage-policy.json with a reason and bump `expectedCounts`.\n"
    + "    bun run --cwd packages/frontend coverage:record\n"
    + `  ${REPRO}`,
  );
}

/*
 * 2b. Every domain file has to APPEAR in the report.
 *
 * Measured on this repository, and the reason this check exists: a syntax error
 * inserted into `lib/socketBfcache.web.ts` left `test:coverage` at exit 0 with
 * 165/165 suites passing, printed only `Failed to collect coverage from …` into
 * the log, and dropped the file out of the denominator — so overall statements
 * went UP, 28.34% to 28.35%. Every percentage-based check in this file reads
 * that as an improvement. The one signal that does not lie is the file's
 * absence from the report, so that is what is asserted.
 *
 * Absent-check: without it, the cheapest way to satisfy a coverage floor is to
 * make a file unparseable.
 */
const absentFromReport = domainFiles.filter(
  (path) => !Object.hasOwn(report, join(packageRoot, path)),
);
if (absentFromReport.length > 0) {
  fail(
    `${absentFromReport.length} behavioural-logic file(s) are missing from the coverage report:`,
    `${absentFromReport.map((path) => `    ${path}`).join("\n")}\n`
    + "  jest reports `Failed to collect coverage from <file>` and carries on at exit\n"
    + "  0, so a file that cannot be parsed simply leaves the denominator and every\n"
    + "  percentage here IMPROVES. Search the run's output for that line.\n"
    + `  ${REPRO}`,
  );
}

/*
 * 3. No stale entries anywhere.
 *
 * Absent-check: a pin naming a deleted file is a pin that can never fail, and a
 * policy that accumulates them decays into a list of nothing.
 */
const domainFileSet = new Set(domainFiles);
const staleEntries = [];
for (const [label, paths] of [
  ["pins", Object.keys(baseline.pins)],
  ["unenforceable", Object.keys(policy.unenforceable)],
  ["belowBarExemptions", Object.keys(policy.belowBarExemptions)],
  ["criticalPaths", Object.values(policy.criticalPaths).flat()],
]) {
  for (const path of paths) {
    if (!existsSync(join(packageRoot, path))) {
      staleEntries.push(`${label}: ${path} — no such file`);
    } else if (!domainFileSet.has(path)) {
      staleEntries.push(`${label}: ${path} — matched by no domain glob`);
    }
  }
}
if (staleEntries.length > 0) {
  fail(
    `${staleEntries.length} coverage-policy entr(ies) no longer describe anything:`,
    `${staleEntries.map((entry) => `    ${entry}`).join("\n")}\n`
    + "  Remove them and bump `expectedCounts` in coverage-policy.json.",
  );
}

/*
 * 4. Exact counts.
 *
 * Absent-check: a floor ("at most N exemptions") is satisfied by every value
 * below it, so a list that shrinks by accident — losing a critical path from
 * the bar — reads as an improvement. Only equality notices both directions.
 */
const actualCounts = {
  domainFiles: domainFiles.length,
  pins: Object.keys(baseline.pins).length,
  unenforceable: Object.keys(policy.unenforceable).length,
  belowBarExemptions: Object.keys(policy.belowBarExemptions).length,
  criticalPaths: new Set(Object.values(policy.criticalPaths).flat()).size,
  allowedBaselineDecreases: policy.allowedBaselineDecreases.length,
  snapshotAssertions: snapshotUsers.length,
};
for (const [name, expected] of Object.entries(policy.expectedCounts)) {
  if (actualCounts[name] !== expected) {
    fail(
      `coverage-policy.json expects ${expected} ${name}, found ${actualCounts[name]}.`,
      "  Every one of these lists is a way to switch the gate off quietly, so each\n"
      + "  carries an exact count rather than a bound. If the change is intended,\n"
      + "  edit `expectedCounts` in the same commit and say why in the message.",
    );
  }
}

/*
 * 5. Per-file pins.
 *
 * Absent-check: the global percentage moves by ~0.1 point when one store loses
 * every test, so nothing aggregate can see it.
 */
const pinFailures = [];
for (const [path, pin] of Object.entries(baseline.pins)) {
  const percentages = percentagesFor(report, path);
  if (!percentages) {
    pinFailures.push(`${path}: absent from the coverage report entirely`);
    continue;
  }
  for (const metric of METRICS) {
    if (percentages[metric] < pin[metric]) {
      pinFailures.push(
        `${path}: ${metric} ${percentages[metric]}% is below its pinned ${pin[metric]}%`,
      );
    }
  }
}
if (pinFailures.length > 0) {
  fail(
    `${pinFailures.length} file(s) lost coverage they had at the recorded baseline:`,
    `${pinFailures.map((entry) => `    ${entry}`).join("\n")}\n`
    + "  Pins only ever fire downwards. Add the assertion back rather than\n"
    + "  re-recording — `coverage:record` cannot lower a pin past the base\n"
    + "  revision without an entry in `allowedBaselineDecreases`.\n"
    + `  ${REPRO}`,
  );
}

/*
 * 6. The critical-path bar.
 *
 * Absent-check: pins alone say "no worse than yesterday", which for a file at
 * 0% is no statement at all. The bar is what says "this particular code is not
 * allowed to be at 0%".
 */
const criticalPaths = new Map();
for (const [area, paths] of Object.entries(policy.criticalPaths)) {
  for (const path of paths) {
    criticalPaths.set(path, area);
  }
}
const barFailures = [];
for (const [path, area] of criticalPaths) {
  if (policy.unenforceable[path]) {
    barFailures.push(
      `${path} (${area}): listed as unenforceable, so it cannot also be a critical path`,
    );
    continue;
  }
  if (policy.belowBarExemptions[path]) continue;
  const percentages = percentagesFor(report, path);
  if (!percentages) {
    barFailures.push(`${path} (${area}): absent from the coverage report`);
    continue;
  }
  for (const [metric, minimum] of Object.entries(policy.criticalPathBar)) {
    if (percentages[metric] < minimum) {
      barFailures.push(
        `${path} (${area}): ${metric} ${percentages[metric]}% is below the `
        + `critical-path bar of ${minimum}%`,
      );
    }
  }
}
if (barFailures.length > 0) {
  fail(
    `${barFailures.length} critical-path file(s) are under the bar:`,
    `${barFailures.map((entry) => `    ${entry}`).join("\n")}\n`
    + "  These are the seven areas issue #700 names — session and account\n"
    + "  switching, composer and post mutations, query keys and invalidation,\n"
    + "  permissions and channels, federation-facing state, deep links and share\n"
    + "  intents, feed pagination and restoration. Raise the coverage; an entry in\n"
    + "  `belowBarExemptions` needs a reason, a date and a bumped exact count.\n"
    + `  ${REPRO}`,
  );
}

/*
 * 7. An exemption that no longer exempts anything must go.
 *
 * Absent-check: without this the list only ever grows, and every entry that
 * became true again keeps sitting there ready to excuse a future regression.
 */
const spentExemptions = Object.keys(policy.belowBarExemptions).filter((path) => {
  const percentages = percentagesFor(report, path);
  if (!percentages) return false;
  return Object.entries(policy.criticalPathBar).every(
    ([metric, minimum]) => percentages[metric] >= minimum,
  );
});
if (spentExemptions.length > 0) {
  fail(
    `${spentExemptions.length} below-bar exemption(s) now clear the bar and must be removed:`,
    `${spentExemptions.map((path) => `    ${path}`).join("\n")}\n`
    + "  Leaving them would hold the door open for a regression that has already\n"
    + "  been fixed. Delete the entries and decrement `expectedCounts`.",
  );
}

/*
 * 8. A web fork with real coverage is not unenforceable, and one without any is.
 *
 * jest-expo resolves the NATIVE platform extension, so `import './X'` never
 * loads `X.web.tsx` — measured on this repo, a syntax error in `Feed.web.tsx`
 * left the suite green. A test that names `../X.web` explicitly does load it,
 * which is why three web forks here carry real coverage. The distinction is
 * invisible in the numbers, so the policy pins it.
 */
const webForkFailures = [];
for (const path of domainFiles) {
  if (!/\.web\.tsx?$/.test(path)) continue;
  const percentages = percentagesFor(report, path);
  const covered = percentages ? report[join(packageRoot, path)].statements.covered : 0;
  const listed = Boolean(policy.unenforceable[path]);
  if (covered > 0 && listed) {
    webForkFailures.push(
      `${path}: has ${covered} covered statements, so it is reachable from the suite — `
      + "move it out of `unenforceable` and pin it",
    );
  }
  if (covered === 0 && !listed && report[join(packageRoot, path)]?.statements.total > 0) {
    webForkFailures.push(
      `${path}: a web fork with no coverage must be listed in \`unenforceable\` — `
      + "jest resolves the native extension, so nothing implicit can ever load it",
    );
  }
}
if (webForkFailures.length > 0) {
  fail(`${webForkFailures.length} web-fork classification problem(s):`, `${webForkFailures.map((entry) => `    ${entry}`).join("\n")}`);
}

/*
 * 9. The global ratchet, both directions.
 *
 * Absent-check downward: a pull request could delete a whole domain's tests and
 * land under the old package.json floor, which sat 13.5 points below the
 * measurement. Absent-check upward: without it the baseline never refreshes,
 * and a suite that reached 40% could fall back to the recorded 28% unnoticed.
 */
const drift = policy.globalDriftAllowancePoints;
for (const metric of METRICS) {
  const current = report.total[metric].pct;
  const recorded = baseline.total[metric].pct;
  if (current < recorded) {
    fail(
      `Overall ${metric} coverage fell to ${current}% from the recorded ${recorded}%.`,
      `  ${report.total[metric].covered}/${report.total[metric].total} against a `
      + `baseline of ${baseline.total[metric].covered}/${baseline.total[metric].total}.\n`
      + "  Cover what the change added, or explain the drop in\n"
      + "  `allowedBaselineDecreases` and re-record.\n"
      + `  ${REPRO}`,
    );
  } else if (current > recorded + drift) {
    fail(
      `Overall ${metric} coverage rose to ${current}% but the baseline still says ${recorded}%.`,
      `  A stale baseline is a ratchet that stopped turning: it would let the suite\n`
      + `  fall all the way back to ${recorded}% later without a word. Re-record it in\n`
      + "  this change:\n"
      + "    bun run --cwd packages/frontend coverage:record\n"
      + `  (the allowance before this fires is ${drift} percentage points).`,
    );
  }
}

/*
 * 10. The baseline may not decrease against the base revision.
 *
 * Absent-check: every check above reads the committed baseline, so a pull
 * request that lowers the baseline in the same commit that removes the tests
 * passes all of them. This is the only check that makes the ratchet a ratchet
 * rather than a self-service dial.
 */
const declaredDecreases = new Map(
  policy.allowedBaselineDecreases.map((entry) => [`${entry.path}:${entry.metric}`, entry]),
);
const observedDecreases = new Set();
// `||`, not `??`: on a workflow_dispatch run GitHub supplies an EMPTY string for
// both `base_ref` and `event.before`, and an empty base resolves to nothing, so
// the check would fail every manual run rather than compare against main.
const baseRevision = options.base || process.env.COVERAGE_POLICY_BASE || "origin/main";

let repositoryRoot = null;
try {
  repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: packageRoot,
    encoding: "utf8",
  }).trim();
} catch {
  repositoryRoot = null;
}

if (repositoryRoot === null) {
  fail(
    "Cannot resolve a git repository, so the baseline's own direction is unchecked.",
    "  Every other check reads the committed baseline; without this one a change\n"
    + "  may lower the baseline and remove the tests in a single commit.\n"
    + "  Run this from a checkout, and pass `--base <rev>` in CI.",
  );
} else {
  const baselineInRepo = relative(repositoryRoot, BASELINE_PATH);
  let baseBaseline = null;
  let baseResolves = true;
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRevision}^{commit}`], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
  } catch {
    baseResolves = false;
  }
  if (!baseResolves) {
    fail(
      `The base revision \`${baseRevision}\` does not resolve in this checkout.`,
      "  Not skipped on purpose: an unresolvable base and a base with no regression\n"
      + "  look identical, and treating them the same is how this check would stop\n"
      + "  measuring. Fetch the base branch, or pass `--base <rev>`.",
    );
  } else {
    try {
      baseBaseline = JSON.parse(
        execFileSync("git", ["show", `${baseRevision}:${baselineInRepo}`], {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {
      // The base revision predates the baseline file. Distinguishable from a
      // broken base because the revision itself resolved a moment ago.
      baseBaseline = null;
    }
  }

  if (baseBaseline) {
    const regressions = [];
    for (const metric of METRICS) {
      const key = `total:${metric}`;
      if (baseline.total[metric].pct < baseBaseline.total[metric].pct) {
        observedDecreases.add(key);
        if (!declaredDecreases.has(key)) {
          regressions.push(
            `total ${metric}: baseline lowered from ${baseBaseline.total[metric].pct}% `
            + `to ${baseline.total[metric].pct}%`,
          );
        }
      }
    }
    for (const [path, basePin] of Object.entries(baseBaseline.pins)) {
      const pin = baseline.pins[path];
      if (!pin) {
        if (existsSync(join(packageRoot, path))) {
          regressions.push(`${path}: pinned on ${baseRevision}, unpinned here while the file still exists`);
        }
        continue;
      }
      for (const metric of METRICS) {
        if (pin[metric] < basePin[metric]) {
          const key = `${path}:${metric}`;
          observedDecreases.add(key);
          if (!declaredDecreases.has(key)) {
            regressions.push(
              `${path}: ${metric} pin lowered from ${basePin[metric]}% to ${pin[metric]}%`,
            );
          }
        }
      }
    }
    if (regressions.length > 0) {
      fail(
        `The recorded baseline is lower than \`${baseRevision}\`'s in ${regressions.length} place(s):`,
        `${regressions.map((entry) => `    ${entry}`).join("\n")}\n`
        + "  Re-recording a lower baseline is how a coverage gate is switched off, so\n"
        + "  each drop needs an entry in `allowedBaselineDecreases` giving the path,\n"
        + "  the metric, the date and why the code legitimately shrank.",
      );
    }
  }
}

/*
 * 11. A declared decrease that is not happening must go.
 *
 * Absent-check: otherwise `allowedBaselineDecreases` is a standing permission
 * slip. An entry that has stopped firing would silently excuse the NEXT drop on
 * the same file.
 */
const spentDecreases = [...declaredDecreases.keys()].filter((key) => !observedDecreases.has(key));
if (spentDecreases.length > 0) {
  fail(
    `${spentDecreases.length} entr(ies) in \`allowedBaselineDecreases\` excuse a decrease that is not happening:`,
    `${spentDecreases.map((key) => `    ${key}`).join("\n")}\n`
    + "  Remove them; a spent entry is a standing permission for the next drop.",
  );
}

/*
 * 12. The pre-existing jest per-file thresholds stay where they are.
 *
 * Absent-check: `lib/viewerQueryKeys.ts` at 100% is the boundary that keeps one
 * account's cached data away from another, and it is enforced by a number in
 * package.json that any edit can lower. Issue #700 asks explicitly that it stay
 * protected, so the policy asserts the number rather than trusting it.
 */
const packageJson = readJson(join(packageRoot, "package.json"));
const jestThresholds = packageJson.jest.coverageThreshold ?? {};
for (const [path, required] of Object.entries(policy.jestOwnedThresholds)) {
  const declared = jestThresholds[path];
  if (!declared) {
    fail(
      `package.json no longer declares a jest coverage threshold for ${path}.`,
      "  It is listed in `jestOwnedThresholds` because it protects a boundary that a\n"
      + "  global percentage cannot see. Restore the entry.",
    );
    continue;
  }
  for (const metric of METRICS) {
    if ((declared[metric] ?? 0) < required[metric]) {
      fail(
        `The jest threshold for ${path} was lowered: ${metric} ${declared[metric]}% < ${required[metric]}%.`,
        "  Add the missing assertion instead. This entry exists because the file is\n"
        + "  load-bearing, not because the number was convenient.",
      );
    }
  }
}

/*
 * 13. Snapshots may not be used to inflate the numbers.
 *
 * Absent-check: `toMatchSnapshot()` over a screen covers hundreds of statements
 * while asserting only that today's output equals today's output. There are
 * none in this package today and the policy keeps it that way.
 */
if (testFiles.length < policy.minimumTestFiles) {
  fail(
    `Only ${testFiles.length} test files were scanned, below the ${policy.minimumTestFiles} floor.`,
    "  A scan that reads nothing reports the same clean snapshot result as a\n"
    + "  package with no snapshots in it.",
  );
}
if (snapshotUsers.length !== policy.expectedCounts.snapshotAssertions) {
  fail(
    `${snapshotUsers.length} test file(s) assert against snapshots; the policy allows `
    + `${policy.expectedCounts.snapshotAssertions}.`,
    `${snapshotUsers.map((path) => `    ${path}`).join("\n")}\n`
    + "  A snapshot over a rendered screen covers hundreds of statements while\n"
    + "  asserting only that today's output equals today's output — coverage without\n"
    + "  confidence, and the cheapest way to satisfy every number above.",
  );
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.error("Frontend coverage policy FAILED\n");
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    `  Policy: packages/frontend/coverage-policy.json\n`
    + `  Baseline: packages/frontend/coverage-baseline.json\n`
    + `  Rationale: packages/frontend/docs/TESTING-POLICY.md\n`,
  );
  process.exit(1);
}

console.log(
  "Frontend coverage policy passed.\n"
  + `  ${domainFiles.length} behavioural-logic files in ${policy.domains.length} domains, `
  + `${Object.keys(baseline.pins).length} pinned, `
  + `${Object.keys(policy.unenforceable).length} unenforceable.\n`
  + `  ${criticalPaths.size} critical-path files at >= ${policy.criticalPathBar.statements}% statements / `
  + `${policy.criticalPathBar.branches}% branches, `
  + `${Object.keys(policy.belowBarExemptions).length} exempted.\n`
  + `  Overall ${report.total.statements.pct}% statements against a recorded `
  + `${baseline.total.statements.pct}%, over ${reportedFiles.length} files.`,
);
