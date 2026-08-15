#!/usr/bin/env bun

/**
 * Mention is licensed under the Breathe License 1.0 (source available, not
 * open source — see `LICENSE`) and every workspace package is `private: true`,
 * never published to npm. The org's canonical table
 * (OxyHQ/.github `licensing/README.md` § License identifier) says a private
 * Breathe package's `package.json` `license` field is `"UNLICENSED"`.
 *
 * That fact drifted silently for a while: every `package.json` in this repo
 * said `"MIT"` (or, at the root, `"SEE LICENSE IN LICENSE"` — the npm-published
 * spelling, wrong for a private package) while `LICENSE` was the Breathe text.
 * Nothing failed a build, because nothing read the field. This is the guard
 * that reads it.
 *
 * A second, narrower check catches the same drift in prose: a first-party
 * Markdown file claiming the repository is "MIT licensed" (a badge or a
 * License section) while `LICENSE` says otherwise. Scoped to the exact
 * phrases that badge/README generators actually produce, not a bare
 * substring match on "MIT" — this repository's own docs occasionally name
 * MIT-licensed THIRD-PARTY dependencies in passing, and that is not the claim
 * this guard exists to catch.
 *
 * Usage: bun scripts/validate-license.mjs
 */

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The one value every package.json in this repo must declare. */
const EXPECTED_LICENSE = "UNLICENSED";

/**
 * Phrases that assert "this repository is MIT licensed" — the specific wrong
 * claim found in `README.md`, `packages/frontend/README.md` and every
 * workspace `package.json` before this guard existed. Not a bare `MIT` scan:
 * that would also fire on a sentence naming an MIT-licensed dependency, which
 * is a true statement this guard has no business rejecting.
 */
const MIT_CLAIM_PATTERNS = [
  /license-MIT-/i, // shields.io badge slug
  /\bMIT License\b/,
  /^\s*MIT\.\s*See \[LICENSE\]/m,
];

const MANIFEST_FILE = /(?:^|\/)package\.json$/;
const MARKDOWN_FILE = /\.mdx?$/;

const findings = [];
const failures = [];

function trackedFiles() {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed in ${repositoryRoot}: ${listed.stderr ?? listed.error}`);
  }
  return listed.stdout.split("\0").filter(Boolean);
}

const tracked = trackedFiles();
const manifests = tracked.filter((path) => MANIFEST_FILE.test(path) && !path.includes("/node_modules/"));
const markdown = tracked.filter((path) => MARKDOWN_FILE.test(path) && !path.includes("/node_modules/"));

// ---------------------------------------------------------- 1. manifests ---

for (const path of manifests) {
  const text = await readFile(resolve(repositoryRoot, path), "utf8");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    failures.push(`${path}: not parseable as JSON, so its license field could not be checked — ${error.message}`);
    continue;
  }
  if (manifest.private !== true) {
    // A package meant to be published to npm is out of scope for this guard —
    // it would take "SEE LICENSE IN LICENSE" (npm's spelling), not
    // "UNLICENSED", and this repo publishes nothing today. Recording it as a
    // finding rather than silently skipping keeps that assumption checkable.
    findings.push({
      file: path,
      rule: `declares "private": ${JSON.stringify(manifest.private)} — this guard only knows the private-package rule`,
    });
    continue;
  }
  if (manifest.license !== EXPECTED_LICENSE) {
    findings.push({
      file: path,
      rule: `license is ${JSON.stringify(manifest.license)}, expected ${JSON.stringify(EXPECTED_LICENSE)}`,
    });
  }
}

// ---------------------------------------------------------- 2. markdown ---

for (const path of markdown) {
  const text = await readFile(resolve(repositoryRoot, path), "utf8");
  for (const pattern of MIT_CLAIM_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({ file: path, rule: `claims an MIT license (matched ${pattern})` });
    }
  }
}

// ------------------------------------------------------- 3. vacuity floors ---

const MINIMUM_MANIFESTS = 5;
const MINIMUM_MARKDOWN = 5;

if (manifests.length < MINIMUM_MANIFESTS) {
  failures.push(
    `${manifests.length} package.json files scanned is below the ${MINIMUM_MANIFESTS} floor — `
    + "the file listing is probably broken, and a broken listing reports a clean tree",
  );
}
if (markdown.length < MINIMUM_MARKDOWN) {
  failures.push(
    `${markdown.length} Markdown files scanned is below the ${MINIMUM_MARKDOWN} floor — `
    + "the file listing is probably broken, and a broken listing reports a clean tree",
  );
}

// ------------------------------------------------------------------ verdict ---

if (findings.length > 0 || failures.length > 0) {
  console.error("License consistency guard failed:\n");
  for (const finding of findings) {
    console.error(`  ${finding.file}: ${finding.rule}`);
  }
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    `\n  Mention is licensed under the Breathe License 1.0 (LICENSE) and every workspace\n`
    + `  package is private. Every package.json "license" field must read\n`
    + `  ${JSON.stringify(EXPECTED_LICENSE)}, and no first-party doc may claim MIT.\n`,
  );
  process.exit(1);
}

console.log(
  `License consistency guard passed — ${manifests.length} package.json files and ${markdown.length} `
  + "Markdown files scanned.",
);
