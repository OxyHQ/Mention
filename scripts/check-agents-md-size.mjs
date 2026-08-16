#!/usr/bin/env bun

/**
 * `AGENTS.md` is loaded into EVERY agent session in this repository, so a byte
 * added here is a byte paid for on every task forever. This keeps it bounded.
 *
 * ## Why a gate rather than a rule somebody remembers
 *
 * Measured: between 2026-06 and 2026-08 the root `AGENTS.md` went from ~10 KB to
 * 478 KB — 6,866 lines, 64 sections, 44 of them a per-issue design note added by
 * the feature branch that closed the issue. Thirty-one of those sections already
 * said "Full reference: `docs/<x>.md`" and then restated the doc anyway.
 *
 * Nothing was wrong with any single one of those diffs. Each added ~100 lines of
 * true, carefully-written prose about work that had just landed, and each was
 * reviewed as part of a feature PR whose subject was the feature. The growth is
 * invisible per-commit and only exists in the sum, which is exactly the shape a
 * gate catches and a convention does not.
 *
 * So this is a budget, not a lint. Adding to `AGENTS.md` is allowed; it just has
 * to be paid for in the same edit, by compressing something or by moving the
 * material to `docs/` and leaving a pointer.
 *
 * ## The two checks
 *
 *   1. **Size.** Each tracked `AGENTS.md` against its budget. The root file is
 *      the loaded-everywhere one and gets the larger allowance; a nested one is
 *      a DELTA on top of its parents and gets very little, because a child that
 *      needs 8 KB is usually repeating a parent.
 *
 *   2. **Per-issue headings.** A heading naming an issue number (`## Foo (#57)`)
 *      is per-issue documentation by definition, and per-issue documentation is
 *      what `docs/` is for. This is the actual mechanism of the 478 KB — it
 *      names it directly, so the failure message can say where the material
 *      goes instead of only saying "too big". Issue numbers in BODY text are
 *      fine and common ("#57 owns the offer"); only headings fire.
 *
 * ## Bytes, not lines, and one bound rather than two
 *
 * The widely-repeated "keep AGENTS.md under 150 lines" figure is an UNCITED
 * blog claim; the one published measurement (arXiv 2601.20404, 10 repos /
 * 124 PRs) reports the opposite direction — having an AGENTS.md at all reduced
 * output tokens ~17-20% and wall-clock ~29%. So the justification here is not a
 * study, it is arithmetic: this file is prepended to every session, so its
 * BYTES are what gets paid for, and bytes are what this measures. A second
 * line-count bound would be a second representation of one fact that could
 * disagree with the first, which is the failure this repository's own house
 * invariants warn about.
 *
 * Both checks carry a vacuity floor: a `git ls-files` that returns nothing, or a
 * repository that has lost its root `AGENTS.md`, reports a clean tree under a
 * naive implementation. `scripts/test-check-agents-md-size.mjs` mutation-tests
 * every rule and both floors.
 */

import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIB = 1024;

/** The root file is loaded on every task in the repo. */
export const ROOT_BUDGET_BYTES = 12 * KIB;

/** A nested file carries only its own delta on top of the root and the parents. */
export const NESTED_BUDGET_BYTES = 8 * KIB;

/** A heading that names an issue. Body prose naming one is fine. */
const ISSUE_HEADING = /^#{1,6} .*#\d{2,4}\b/;

/**
 * At least one `AGENTS.md` must be found and the ROOT one must be among them.
 * "I measured nothing" and "everything is under budget" are the same output
 * without this.
 */
function assertScanSawSomething(paths) {
  if (paths.length === 0) {
    throw new Error(
      "check-agents-md-size: found NO tracked AGENTS.md. The file listing is broken — this is a failure, not a clean tree.",
    );
  }
  if (!paths.includes("AGENTS.md")) {
    throw new Error(
      "check-agents-md-size: the root AGENTS.md is not in the tracked file listing. The file listing is broken, or the repo lost the one file this gate exists for.",
    );
  }
}

export function budgetFor(path) {
  return path === "AGENTS.md" ? ROOT_BUDGET_BYTES : NESTED_BUDGET_BYTES;
}

export function issueHeadings(contents) {
  return contents
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => ISSUE_HEADING.test(line));
}

export async function checkAgentsMdSize({
  root,
  rootBudgetBytes = ROOT_BUDGET_BYTES,
  nestedBudgetBytes = NESTED_BUDGET_BYTES,
  enforceIssueHeadings = true,
} = {}) {
  const repositoryRoot = root ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

  const listing = execFileSync("git", ["ls-files", "-z", "AGENTS.md", "**/AGENTS.md"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const paths = listing.split("\0").filter(Boolean).sort();

  assertScanSawSomething(paths);

  const failures = [];

  for (const path of paths) {
    const contents = await readFile(resolve(repositoryRoot, path), "utf8");
    const bytes = Buffer.byteLength(contents, "utf8");
    const budget = path === "AGENTS.md" ? rootBudgetBytes : nestedBudgetBytes;

    if (bytes > budget) {
      failures.push(
        `${path} is ${(bytes / KIB).toFixed(1)} KB, over its ${(budget / KIB).toFixed(0)} KB budget by ${((bytes - budget) / KIB).toFixed(1)} KB.\n` +
          `    Compress something in the SAME edit, or move the material to docs/ and leave a one-line pointer.`,
      );
    }

    if (enforceIssueHeadings) {
      for (const { line, number } of issueHeadings(contents)) {
        failures.push(
          `${path}:${number} is a per-issue heading: ${line.trim()}\n` +
            `    Per-issue design notes go in docs/ (see docs/index.mdx). AGENTS.md gets the RULE and a pointer.`,
        );
      }
    }
  }

  return { paths, failures };
}

if (import.meta.main) {
  const { paths, failures } = await checkAgentsMdSize();

  if (failures.length > 0) {
    console.error("AGENTS.md budget check FAILED:\n");
    for (const failure of failures) console.error(`  - ${failure}\n`);
    process.exit(1);
  }

  console.log(`AGENTS.md budget check passed (${paths.length} file(s): ${paths.join(", ")}).`);
}
