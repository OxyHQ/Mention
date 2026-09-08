#!/usr/bin/env bun

/**
 * Mutation-tests `validate-id-shape.mjs`.
 *
 * The bug this gate exists for was itself a check that could not fail: five
 * `/^[a-f0-9]{24}$/` tests kept passing their suites while answering "no" for
 * every id Oxy had minted in six weeks. A gate against that class must not have
 * the same property, and every part of this one is a regex or a file listing —
 * both of which fail QUIET. A broken `git ls-files` reports a clean tree; a
 * typo'd character class reports a clean tree.
 *
 * So each case below breaks exactly one thing and requires the gate to fail,
 * with words that identify the right rule. The cases that must PASS matter
 * just as much: this repository documents every id pattern it has REMOVED, in
 * prose that quotes the pattern, and it keeps four redaction sites that match
 * ids on purpose. A gate that fired on either would be turned off the same day.
 *
 * Fixtures are real trees with a real `git init`, so the gate's own file listing
 * runs rather than a stand-in for it.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-id-shape.mjs");

async function runAgainst(files, { realFloors = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "id-shape-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }
    Bun.spawnSync({ cmd: ["git", "-c", "init.defaultBranch=main", "init", "-q"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "add", "-A", "-f"], cwd: root });

    const environment = { ...process.env, ID_SHAPE_VALIDATOR_ROOT: root };
    if (!realFloors) environment.ID_SHAPE_VALIDATOR_FIXTURE_FLOORS = "1";

    const proc = Bun.spawnSync({
      cmd: ["bun", validator],
      cwd: repositoryRoot,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The four live `KNOWN_EXCEPTIONS` files, each carrying the text its entry
 * excuses. Every fixture tree needs them: an entry that matches nothing is a
 * failure, so a tree without them fails for a reason no case is testing.
 */
function cleanTree(extra = {}) {
  const redaction = 'export const ID = /\\b[0-9a-f]{24}\\b/gi;\n';
  return {
    "packages/backend/src/utils/logger.ts": redaction,
    "packages/frontend/lib/logging/sanitize.ts": redaction,
    "packages/mcp/lib/logger.ts": redaction,
    "packages/backend/src/utils/oxyMetrics.ts": redaction,
    ...extra,
  };
}

const cases = [];
function check(name, condition, detail) {
  cases.push({ name, ok: condition, detail });
}

// ── the tree as it stands: clean ────────────────────────────────────────────
{
  const { exitCode, output } = await runAgainst(cleanTree());
  check("a tree with only the allow-listed redactions passes", exitCode === 0, output);
}

// ── each rule fires ─────────────────────────────────────────────────────────
{
  const { exitCode, output } = await runAgainst(
    cleanTree({ "packages/backend/src/thing.ts": "export const isId = (v) => /^[a-f0-9]{24}$/.test(v);\n" }),
  );
  check(
    "a 24-hex recogniser fails, naming the rule",
    exitCode === 1 && output.includes("24-hex id pattern"),
    output,
  );
}
{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/thing.ts":
        "export const RE = /\\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b/g;\n",
    }),
  );
  check(
    "a version-pinned uuid fails, naming the rule",
    exitCode === 1 && output.includes("pinned to a version nibble"),
    output,
  );
}
{
  // Pinned to 7 — the version we DO mint. Still wrong as a recogniser: it
  // excludes every pre-cutover id, and the next version after it.
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/frontend/thing.ts":
        "export const RE = /\\b[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b/g;\n",
    }),
  );
  check(
    "a uuid pinned to v7 fails too — the rule is about pinning, not about which version",
    exitCode === 1 && output.includes("pinned to a version nibble"),
    output,
  );
}
{
  const { exitCode, output } = await runAgainst(
    cleanTree({ "packages/backend/src/thing.ts": "if (isValidObjectId(id)) return null;\n" }),
  );
  check(
    "an ObjectId validity check fails, naming the rule",
    exitCode === 1 && output.includes("ObjectId validity check"),
    output,
  );
}

// ── the exemptions, each of which a naive gate gets wrong ───────────────────
{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/backend/src/documented.ts":
        "// This used to carry its own `/^[a-f0-9]{24}$/`, removed at the cutover.\n" +
        "/* ObjectId.isValid(id) stood here and rejected every post since. */\n" +
        "export const ok = true;\n",
    }),
  );
  check(
    "prose that QUOTES a removed pattern passes — the explanations are the point",
    exitCode === 0,
    output,
  );
}
{
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/backend/src/__tests__/mint.test.ts":
        "expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);\n",
      "packages/backend/src/legacy.test.ts": "const legacy = /^[a-f0-9]{24}$/;\n",
    }),
  );
  check(
    "tests may assert what we MINT and may write a legacy id down",
    exitCode === 0,
    output,
  );
}
{
  // A `//` inside a string must not blank the rest of the line: that is how a
  // comment-stripper written as a regex loses a real finding.
  const { exitCode, output } = await runAgainst(
    cleanTree({
      "packages/backend/src/tricky.ts":
        "const base = 'https://cloud.oxy.so/'; const isId = /^[a-f0-9]{24}$/;\n",
    }),
  );
  check(
    "a pattern after a URL literal on the same line still fails",
    exitCode === 1 && output.includes("24-hex id pattern"),
    output,
  );
}

// ── the list may only shrink ────────────────────────────────────────────────
{
  const tree = cleanTree();
  delete tree["packages/mcp/lib/logger.ts"];
  const { exitCode, output } = await runAgainst(tree);
  check(
    "an allow-list entry that no longer matches anything fails",
    exitCode === 1 && output.includes("no longer matches anything"),
    output,
  );
}

// ── the vacuity floor ───────────────────────────────────────────────────────
{
  const { exitCode, output } = await runAgainst(cleanTree(), { realFloors: true });
  check(
    "a tree far below the file floor fails rather than reporting clean",
    exitCode === 1 && output.includes("source file(s) were scanned"),
    output,
  );
}

const failed = cases.filter((c) => !c.ok);
for (const c of cases) console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name}`);
if (failed.length > 0) {
  console.error(`\n${failed.length} case(s) failed:\n`);
  for (const c of failed) console.error(`--- ${c.name}\n${c.detail}\n`);
  process.exit(1);
}
console.log(`\n${cases.length} mutation cases pass.`);
