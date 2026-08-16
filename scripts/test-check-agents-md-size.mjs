#!/usr/bin/env bun

/**
 * Mutation-tests `check-agents-md-size.mjs`.
 *
 * A budget gate is the easiest kind to leave inert: every part of it is a file
 * listing or a byte count, and both fail QUIET. A broken `git ls-files` reports
 * a clean tree. A regex with a typo reports a clean tree. A budget nobody is
 * near reports a clean tree forever, including after somebody has deleted the
 * comparison.
 *
 * Each case below breaks exactly one thing and requires the gate to fail with
 * the words that identify the right rule. The cases that must PASS matter as
 * much: this repository's prose names issue numbers constantly, on purpose, and
 * a gate that fired on body text would be disabled by whoever hit it first.
 *
 * Fixtures are real trees with a real `git init`, so the gate's actual file
 * listing runs rather than a stand-in for it.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkAgentsMdSize, issueHeadings } from "./check-agents-md-size.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;

function report(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
}

/** Build a scratch checkout and run the REAL gate against it. */
async function runAgainst(files, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "agents-md-budget-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, contents, "utf8");
    }
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    try {
      return { result: await checkAgentsMdSize({ root, ...options }) };
    } catch (error) {
      return { error };
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const withinBudget = "# Mercaria\n\nA rule.\n";

console.log("check-agents-md-size self-test\n");

// --- the vacuity floors -----------------------------------------------------

{
  const { error } = await runAgainst({ "README.md": "no instructions here\n" });
  report(
    "floor: a tree with no AGENTS.md is a FAILURE, not a clean scan",
    Boolean(error) && /found NO tracked AGENTS\.md/.test(error.message),
    error ? error.message : "the gate returned success",
  );
}

{
  const { error } = await runAgainst({ "packages/backend/AGENTS.md": withinBudget });
  report(
    "floor: a tree whose ROOT AGENTS.md is missing is a FAILURE",
    Boolean(error) && /root AGENTS\.md is not in the tracked file listing/.test(error.message),
    error ? error.message : "the gate returned success",
  );
}

// --- the size rule ----------------------------------------------------------

{
  const { result } = await runAgainst({ "AGENTS.md": withinBudget });
  report(
    "a small root AGENTS.md passes",
    result?.failures.length === 0,
    result ? result.failures.join("; ") : "threw",
  );
}

{
  const { result } = await runAgainst({ "AGENTS.md": "#".repeat(20 * 1024) + "\n" });
  report(
    "an over-budget root AGENTS.md fails, naming the budget",
    result?.failures.length === 1 && /over its 12 KB budget/.test(result.failures[0]),
    result ? result.failures.join("; ") : "threw",
  );
}

{
  // The nested budget is a DIFFERENT number and must actually be applied: a gate
  // that used the root budget everywhere would pass this.
  const { result } = await runAgainst({
    "AGENTS.md": withinBudget,
    "packages/backend/AGENTS.md": "x".repeat(10 * 1024) + "\n",
  });
  report(
    "a nested AGENTS.md is held to the SMALLER budget",
    result?.failures.length === 1 &&
      /packages\/backend\/AGENTS\.md/.test(result.failures[0]) &&
      /over its 8 KB budget/.test(result.failures[0]),
    result ? result.failures.join("; ") : "threw",
  );
}

{
  // Same bytes, root path: proves the previous case failed on the BUDGET rather
  // than on the size alone. 10 KB sits strictly between the two budgets, which
  // is what makes the pair a discriminator at all.
  const { result } = await runAgainst({ "AGENTS.md": "x".repeat(10 * 1024) + "\n" });
  report(
    "control: the same 10 KB passes at the ROOT path",
    result?.failures.length === 0,
    result ? result.failures.join("; ") : "threw",
  );
}

// --- the per-issue-heading rule --------------------------------------------

{
  const { result } = await runAgainst({
    "AGENTS.md": "# Mercaria\n\n## The unified offer model (#57, ADR 0002)\n\nprose\n",
  });
  report(
    "a per-issue HEADING fails and says where it goes",
    result?.failures.length === 1 &&
      /per-issue heading/.test(result.failures[0]) &&
      /docs\//.test(result.failures[0]),
    result ? result.failures.join("; ") : "threw",
  );
}

{
  const { result } = await runAgainst({
    "AGENTS.md": "# Mercaria\n\n## Offers\n\n#57 owns the offer row; see docs/commerce-graph.md (#55, #58).\n",
  });
  report(
    "an issue number in BODY prose passes",
    result?.failures.length === 0,
    result ? result.failures.join("; ") : "threw",
  );
}

{
  // A one-digit "#1" in a heading is far likelier to be a step number or an
  // anchor than an issue, so the rule requires two digits. Pin that boundary,
  // or a later tightening breaks headings nobody meant to forbid.
  report(
    "a one-digit '#1' in a heading does not fire; '#57' does",
    issueHeadings("## Step #1\n").length === 0 && issueHeadings("## Offers (#57)\n").length === 1,
  );
}

// --- the real repository ----------------------------------------------------

{
  const { result, error } = await checkAgentsMdSize({ root: repositoryRoot })
    .then((result) => ({ result }))
    .catch((error) => ({ error }));
  report(
    "the real repository is within budget",
    !error && result?.failures.length === 0,
    error ? error.message : result?.failures.join("\n       "),
  );
}

console.log("");
if (failed > 0) {
  console.error(`${failed} self-test case(s) FAILED.`);
  process.exit(1);
}
console.log("All self-test cases passed.");
