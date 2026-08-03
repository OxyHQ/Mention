#!/usr/bin/env node
/**
 * The gate's own self-test — because a gate nobody has seen fail is
 * indistinguishable from one that cannot.
 *
 * Mirrors `test-validate-logger-error-args.mjs`: the validator is pure, so each
 * failure shape is driven with a synthetic report rather than by breaking the
 * real suite. Every case that must FAIL is asserted to fail AND to name the
 * offending file — "a number moved" is not evidence, since a broken validator
 * moves numbers too.
 */

import { validateCollection, report } from './validate-suite-collection.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A report entry that collected `n` cases. */
const file = (name, n) => ({
  name,
  assertionResults: Array.from({ length: n }, (_unused, i) => ({
    fullName: `case ${i}`,
    status: 'passed',
  })),
});

/** Everything the gate prints, as one string, so we can assert it NAMES things. */
function output(result) {
  const lines = [];
  report(result, (line) => lines.push(line));
  return lines.join('\n');
}

console.log('validate-suite-collection self-test:');

// ---------------------------------------------------------------- healthy ---
{
  const disk = ['/repo/a.test.ts', '/repo/b.test.ts'];
  const result = validateCollection(
    { testResults: [file('/repo/a.test.ts', 3), file('/repo/b.test.ts', 1)], numTotalTests: 4 },
    disk,
  );
  check('a healthy suite passes', result.ok === true);
  check('counts are reported', result.counts.filesOnDisk === 2 && result.counts.filesInReport === 2);
}

// ------------------------------------------- INVARIANT 2: died at load ------
{
  const result = validateCollection(
    { testResults: [file('/repo/a.test.ts', 3), file('/repo/dead.test.ts', 0)], numTotalTests: 3 },
    ['/repo/a.test.ts', '/repo/dead.test.ts'],
  );
  check('a file collecting ZERO tests FAILS the gate', result.ok === false);
  check('and the gate NAMES it', output(result).includes('/repo/dead.test.ts'));
}

// ---- the exact shape from 2026-08-03: ratio IMPROVES while a file is dead ---
{
  // 1 of 2 files dead, and every case that DID run passed. A pass-ratio gate
  // reads 100%. This is the case the whole script exists for.
  const result = validateCollection(
    { testResults: [file('/repo/alive.test.ts', 9), file('/repo/dead.test.ts', 0)], numTotalTests: 9 },
    ['/repo/alive.test.ts', '/repo/dead.test.ts'],
  );
  check('100% passing with a dead file still FAILS', result.ok === false);
  check(
    'and says why the ratio is misleading',
    output(result).includes('pass ratio IMPROVES'),
  );
}

// --------------------------------- INVARIANT 1: never picked up at all ------
{
  const result = validateCollection(
    { testResults: [file('/repo/a.test.ts', 3)], numTotalTests: 3 },
    ['/repo/a.test.ts', '/repo/never-ran.test.ts'],
  );
  check('a file on disk but ABSENT from the report FAILS', result.ok === false);
  check('and the gate NAMES it', output(result).includes('/repo/never-ran.test.ts'));
  // The message must name BOTH causes, because the fix differs: an import-time
  // error is a broken file, an uncovered `include` is a config decision. A
  // message naming only the first sends the reader hunting a file that is fine.
  const text = output(result);
  check('and names the DIED-AT-COLLECTION cause', text.includes('died before collection'));
  check('and names the INCLUDE-PATTERN cause', text.includes('`include` does not cover it'));
}

// ------------------------------------------------------ skips are safe ------
{
  const skipped = {
    name: '/repo/skipped.test.ts',
    assertionResults: [{ fullName: 'x', status: 'skipped' }],
  };
  const result = validateCollection(
    { testResults: [skipped], numTotalTests: 1 },
    ['/repo/skipped.test.ts'],
  );
  check('a fully-skipped file PASSES (it still collects)', result.ok === true);
}

// -------------------------------------------- the soft signal is soft -------
{
  // Tests collected dropping to zero is NOT itself a failure when the structure
  // is intact — otherwise the hard check acquires a number to maintain.
  const result = validateCollection({ testResults: [], numTotalTests: 0 }, []);
  check('an empty-but-consistent run does not hard-fail', result.ok === true);
}

// ------------------------------------ staleness is NOT a failure -----------
{
  // A test file written after the report finished cannot be in it. Failing for
  // that is definitionally wrong and is how a gate gets a reputation for crying
  // wolf. Measured on 2026-08-03: BOTH invariant-1 hits against the real suite
  // were files created 32 seconds and 18 minutes after the report.
  const REPORT_AT = 1_000;
  const result = validateCollection(
    { testResults: [file('/repo/a.test.ts', 2)], numTotalTests: 2 },
    ['/repo/a.test.ts', '/repo/brand-new.test.ts'],
    new Map([['/repo/a.test.ts', 500], ['/repo/brand-new.test.ts', 2_000]]),
    REPORT_AT,
  );
  check('a file NEWER than the report does not fail the gate', result.ok === true);
  check(
    'it is reported as staleness instead',
    result.missingCreatedAfterReport.includes('/repo/brand-new.test.ts'),
  );
  check('and the note says re-run', output(result).includes('re-run the suite'));
}

{
  // The other side: a file OLDER than the report and absent from it really was
  // never run, and must still hard-fail. Without this, the staleness escape
  // hatch would swallow the invariant it is meant to protect.
  const result = validateCollection(
    { testResults: [file('/repo/a.test.ts', 2)], numTotalTests: 2 },
    ['/repo/a.test.ts', '/repo/never-ran.test.ts'],
    new Map([['/repo/a.test.ts', 500], ['/repo/never-ran.test.ts', 500]]),
    1_000,
  );
  check('a file OLDER than the report and absent still FAILS', result.ok === false);
  check('and is named as a real miss', output(result).includes('never reported them'));
}

// --------------- the cutoff is the run's START, not the report's write ------
{
  // Regression on a real misclassification: a file written DURING the run (after
  // collection, before the report landed) was reported as "never ran" when the
  // report's mtime was used. `startTime` is when the file list was collected, so
  // it is the only correct cutoff. No override passed here on purpose — this
  // asserts the default reads `startTime`.
  const result = validateCollection(
    { testResults: [file('/repo/a.test.ts', 2)], numTotalTests: 2, startTime: 1_000 },
    ['/repo/a.test.ts', '/repo/mid-run.test.ts'],
    new Map([['/repo/a.test.ts', 500], ['/repo/mid-run.test.ts', 1_500]]),
  );
  check('a file created mid-run is staleness, not a miss', result.ok === true);
  check(
    'and startTime is what decided it',
    result.missingCreatedAfterReport.includes('/repo/mid-run.test.ts'),
  );
}

{
  // With no startTime and no override there is nothing to compare against, so
  // the gate must NOT silently excuse an absent file — unknown reads as "ran".
  const result = validateCollection(
    { testResults: [file('/repo/a.test.ts', 2)], numTotalTests: 2 },
    ['/repo/a.test.ts', '/repo/absent.test.ts'],
    new Map([['/repo/absent.test.ts', 9_999]]),
  );
  check('with no startTime, an absent file still FAILS', result.ok === false);
}

// ------------------------------------------- a broken report is caught ------
{
  const result = validateCollection({}, ['/repo/a.test.ts']);
  check('a report with no testResults FAILS rather than passing vacuously', result.ok === false);
}

console.log('');
if (failures > 0) {
  console.log(`${failures} self-test failure(s) — the gate does not behave as documented.`);
  process.exit(1);
}
console.log('all self-tests passed');
