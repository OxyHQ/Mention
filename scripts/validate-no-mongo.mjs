#!/usr/bin/env bun

/**
 * Mention is PostgreSQL-only. This refuses to let MongoDB back in by accident.
 *
 * ## What it guards, and why a guard rather than a memory
 *
 * MongoDB and Mongoose were removed wholesale (issue #706): the backfill copier,
 * every Mongoose model, the driver dependencies, the connection config. What
 * makes that removal fragile is not the code — it is that Mongo comes back in
 * SMALL pieces, each individually reasonable and none of them alarming in a
 * diff. A `mongodb` dependency arrives as a transitive of something else and
 * gets hoisted into a manifest to pin it. A `MONGODB_URI` reappears in a
 * workflow because a one-shot needed it. Someone reaches for
 * `mongodb-memory-server` because it is the fixture library they know.
 *
 * None of those fail a build. The first one that DOES fail something is the
 * fourth or fifth, by which point the honest description of the repository is
 * "two databases", and nobody decided that.
 *
 * So this is a decision gate, not a lint: reintroducing Mongo is allowed, it
 * just has to be a decision somebody makes on purpose and writes down, either by
 * deleting this file or by adding a reasoned `KNOWN_EXCEPTIONS` entry.
 *
 * ## The four surfaces
 *
 *   1. **Manifests** — a banned package named in any dependency field, in the
 *      root `overrides`, or in `workspaces.catalog`.
 *   2. **The lockfile** — a recorded resolution for a Mongo driver, which is
 *      what actually lands the code in `node_modules` whatever the manifests
 *      say. Matched on the resolution's own package NAME, never as a substring,
 *      so `mongodb-memory-server` and `mongodb` stay distinguishable and an
 *      unrelated package whose name contains one of them cannot trip it.
 *   3. **Source imports** — real import syntax only, anchored on a
 *      quote-delimited specifier. A docblock writing `import mongoose` in
 *      backticks is prose about history and must not fire; this repository's
 *      comments are FULL of such prose, deliberately, and a gate that fired on
 *      it would be turned off within a day.
 *   4. **Config and env** — `MONGODB_URI` or a live `mongodb://` /
 *      `mongodb+srv://` connection string in an env template, a compose file, a
 *      workflow, a `.github` shell script, or any source file.
 *
 * Markdown is exempt everywhere. Docs are where the history of a migration is
 * supposed to live, and a guard that forbade describing Mongo in prose would be
 * asking the repository to forget why it moved. That exemption is a property of
 * the four scan sets rather than a filter: none of the patterns below can match
 * a `.md` path. An explicit markdown exclusion WAS written here and removed —
 * mutation-testing showed it could be deleted with every self-test still green,
 * because no input exists that the two versions answer differently. Widening
 * `SOURCE_FILE` is what would change that, and a self-test case stands over it.
 *
 * ## Two near-misses that are wanted, and must keep passing
 *
 * Both loggers redact Mongo URIs out of log lines — `packages/mcp/lib/logger.ts`
 * and `packages/backend/src/utils/logger.ts` each carry a pattern whose source
 * text reads `mongodb(?:\+srv)?):\/\/`. That is a REDACTION and it stays: logs
 * can still carry a legacy URI from somewhere upstream. The connection-string
 * check looks for the literal `mongodb://`, which that escaped regex source does
 * not contain, so neither file matches — verified rather than assumed, and
 * pinned by a self-test case.
 *
 * The same files carry `mongouri` and `mongoUri` as redaction KEY names, and
 * those pass for a duller reason than they look: the env-variable check wants
 * the character sequence `mongodb_uri`, and a key spelled `mongouri` simply is
 * not it. A case-sensitive check was written here first, justified by those
 * keys; the justification was wrong, since no casing of `MONGODB_URI` matches
 * them either. It reads case-INSENSITIVELY now, which is strictly the broader
 * check and costs nothing — measured, no case variant exists in the tree.
 *
 * Usage:  bun scripts/validate-no-mongo.mjs
 */

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The tree to scan. Overridable so the self-test can point the REAL validator at
 * a scratch checkout instead of asserting against a copy of its own logic.
 */
const repositoryRoot = process.env.NO_MONGO_VALIDATOR_ROOT
  ? resolve(process.env.NO_MONGO_VALIDATOR_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Fixture trees are a handful of files, so the real vacuity floors would fail
 * every self-test case for the wrong reason. This lowers them to 1 — it never
 * removes them, so a fixture run still catches a traversal that finds nothing,
 * and the floor that matters stays hard in every normal run.
 */
const fixtureFloors = process.env.NO_MONGO_VALIDATOR_FIXTURE_FLOORS === "1";

/** Packages that mean "Mongo is back", in a manifest. */
const BANNED_PACKAGES = [
  "mongoose",
  "mongodb",
  "mongodb-memory-server",
  "bson",
  "connect-mongo",
  "@typegoose/typegoose",
  "mongodb-client-encryption",
];

/**
 * Packages that mean "Mongo is back", in the lockfile. Narrower than the
 * manifest set on purpose: these four are only ever Mongo, while `bson` and the
 * encryption addon can legitimately arrive as somebody else's transitive without
 * a line of Mongo code being reachable. The lockfile records the whole tree, so
 * it is the one surface where that distinction is worth drawing.
 */
const BANNED_LOCK_PACKAGES = ["mongoose", "mongodb", "mongodb-memory-server", "connect-mongo"];

/**
 * Deliberate, reasoned survivals. Each entry excuses findings in ONE file whose
 * matched text contains `pattern`.
 *
 * The list must only SHRINK: an entry that stops matching anything FAILS the
 * run, so a workaround cannot outlive the thing it worked around. Same
 * discipline as `ACCEPTED_OVERRIDE_RANGE_VIOLATIONS` in `validate-lockfile.mjs`,
 * for the same reason — a stale exception is indistinguishable from a real one
 * until somebody audits the list, and nobody audits the list.
 */
const KNOWN_EXCEPTIONS = [
  {
    file: "packages/backend/src/__tests__/utils/loggerSanitization.test.ts",
    pattern: "mongodb://",
    reason:
      "Fixture input for the log sanitiser, which redacts Mongo URIs so a legacy one arriving from "
      + "upstream never reaches a log sink. The literal is the string being redacted, not a database "
      + "Mention connects to — deleting it would delete the proof that the redaction works.",
  },
  {
    file: ".github/workflows/deploy-aws.yml",
    pattern: "TASK_SECRET_REMOVALS: MONGODB_URI",
    reason:
      "The directive that keeps the secret OFF the ECS task definition. It names MONGODB_URI in order "
      + "to remove it, every deploy: the definition is derived from the LIVE one, so a secret nobody "
      + "names survives indefinitely. Deleting this line does not remove Mongo, it removes the "
      + "enforcement that Mongo stays removed, and a Terraform apply or a hand-registered revision then "
      + "puts the secret back with nothing to strip it. This guard flagged the line once and it was "
      + "deleted in response (restored in e0f7e08e) — which is precisely why the exception exists rather "
      + "than a rewrite.",
  },
];

const MINIMUM_MANIFESTS = fixtureFloors ? 1 : 4;
const MINIMUM_SOURCE_FILES = fixtureFloors ? 1 : 800;
const MINIMUM_LOCK_RESOLUTIONS = fixtureFloors ? 1 : 800;

const SOURCE_FILE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const MANIFEST_FILE = /(?:^|\/)package\.json$/;
const ENV_TEMPLATE_FILE = /(?:^|\/)\.env[^/]*\.example$/;
const COMPOSE_FILE = /(?:^|\/)docker-compose[^/]*\.ya?ml$/;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const SHELL_SCRIPT_FILE = /^\.github\/scripts\/[^/]+\.sh$/;

/**
 * The guard cannot be its own subject. This file names every banned package and
 * both URI shapes because that is what it is FOR, and the self-test carries a
 * fixture for each of them; scanned, the pair reports itself on every run.
 *
 * Excluded by path rather than through `KNOWN_EXCEPTIONS`, which is for content
 * that legitimately survives in the tree at large — a content-matched entry here
 * would go stale every time the guard's own wording changed, and the shrink
 * discipline would then fight ordinary edits to the guard. A rename cannot make
 * this fail quietly: the renamed file falls back into the scan and reports
 * itself loudly, which is the signal to update this list.
 */
const GUARD_OWN_FILES = new Set(["scripts/validate-no-mongo.mjs", "scripts/test-validate-no-mongo.mjs"]);

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Real import syntax for a banned module, including subpaths. Longest name
 * first so `mongodb-memory-server` is never reported as `mongodb`.
 *
 * The specifier MUST be quote-delimited, which is the whole reason a docblock
 * saying `import mongoose` in backticks does not match. A quoted specifier
 * inside a COMMENT does match, and that is intended: a commented-out import is
 * one keystroke from being a live one.
 */
const BANNED_IMPORT = new RegExp(
  "(?:\\bfrom\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)"
  + `(['"])(?:${[...BANNED_PACKAGES].sort((a, b) => b.length - a.length).map(escapeForRegExp).join("|")})`
  + "(?:/[^'\"]*)?\\1",
);

/**
 * The env variable, in any casing and under any suffix — `MONGODB_URI_LEGACY`
 * and a lowercased `mongodb_uri` config key are both the same reference. No
 * trailing word boundary, deliberately: a suffixed spelling is the likeliest way
 * one comes back, and nothing benign is spelled this way.
 */
const MONGO_ENV_VARIABLE = /\bMONGODB_URI/i;

/** A live connection string. Escaped regex SOURCE containing `:\/\/` cannot match. */
const MONGO_CONNECTION_STRING = /\bmongodb(?:\+srv)?:\/\//i;

/** One line of bun.lock's `packages` map: `"key": ["name@version", …],`. */
const LOCK_RESOLUTION = /^\s*"[^"]+":\s*\[\s*"([^"]+)"/;

/** `@scope/name@1.2.3` → `@scope/name`; `name@1.2.3` → `name`. */
function packageNameOf(resolution) {
  const separator = resolution.indexOf("@", resolution.startsWith("@") ? 1 : 0);
  return separator === -1 ? resolution : resolution.slice(0, separator);
}

/** Every file git tracks, repo-relative — so ignored and generated files cannot count. */
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

/** The 1-based line holding `needle`, or 1 when the text has moved on. */
function lineHolding(lines, needle) {
  const index = lines.findIndex((line) => line.includes(needle));
  return index === -1 ? 1 : index + 1;
}

const findings = [];
const failures = [];

const record = (file, line, match, rule) => findings.push({ file, line, match, rule });

const tracked = trackedFiles();
const manifests = tracked.filter((path) => MANIFEST_FILE.test(path));
const sources = tracked.filter((path) => SOURCE_FILE.test(path) && !GUARD_OWN_FILES.has(path));
const configs = tracked.filter(
  (path) =>
    ENV_TEMPLATE_FILE.test(path)
    || COMPOSE_FILE.test(path)
    || WORKFLOW_FILE.test(path)
    || SHELL_SCRIPT_FILE.test(path),
);

// ------------------------------------------------------------- 1. manifests ---

/** Every key in `overrides`, however deeply an npm-style nested override nests it. */
function overrideKeys(value, collected = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return collected;
  for (const [key, nested] of Object.entries(value)) {
    collected.push(key);
    overrideKeys(nested, collected);
  }
  return collected;
}

for (const path of manifests) {
  const text = await readFile(resolve(repositoryRoot, path), "utf8");
  const lines = text.split("\n");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    failures.push(`${path}: not parseable as JSON, so its dependencies could not be checked — ${error.message}`);
    continue;
  }

  const declared = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const block = manifest[field];
    if (!block || typeof block !== "object") continue;
    for (const name of Object.keys(block)) declared.push([field, name]);
  }
  for (const name of overrideKeys(manifest.overrides)) declared.push(["overrides", name]);
  for (const name of Object.keys(manifest.workspaces?.catalog ?? {})) declared.push(["workspaces.catalog", name]);

  for (const [field, name] of declared) {
    if (!BANNED_PACKAGES.includes(name)) continue;
    const quoted = `"${name}"`;
    record(
      path,
      lineHolding(lines, quoted),
      (lines.find((line) => line.includes(quoted)) ?? `${field}.${name}`).trim(),
      `${field} declares ${name}`,
    );
  }
}

// ------------------------------------------------------------- 2. lockfile ---

let lockResolutions = 0;
if (tracked.includes("bun.lock")) {
  const lines = (await readFile(resolve(repositoryRoot, "bun.lock"), "utf8")).split("\n");
  for (const [index, line] of lines.entries()) {
    const matched = LOCK_RESOLUTION.exec(line);
    if (!matched) continue;
    lockResolutions += 1;
    const name = packageNameOf(matched[1]);
    if (!BANNED_LOCK_PACKAGES.includes(name)) continue;
    record("bun.lock", index + 1, line.trim().slice(0, 160), `resolves ${name}`);
  }
} else if (!fixtureFloors) {
  failures.push(
    "bun.lock is not tracked, so the resolution scan had nothing to read — the guard's second surface is blind",
  );
}

// ---------------------------------------------- 3 & 4. sources and config ---

for (const path of [...sources, ...configs]) {
  const isSource = SOURCE_FILE.test(path);
  const lines = (await readFile(resolve(repositoryRoot, path), "utf8")).split("\n");

  for (const [index, line] of lines.entries()) {
    if (isSource && BANNED_IMPORT.test(line)) {
      record(path, index + 1, line.trim(), "imports a Mongo driver");
    }
    if (MONGO_ENV_VARIABLE.test(line)) {
      record(path, index + 1, line.trim(), "names MONGODB_URI");
    }
    if (MONGO_CONNECTION_STRING.test(line)) {
      record(path, index + 1, line.trim(), "carries a mongodb:// connection string");
    }
  }
}

// ---------------------------------------------------------- 5. exceptions ---

const honoured = new Set();
const unexcused = findings.filter((finding) => {
  const entry = KNOWN_EXCEPTIONS.find(
    (exception) => exception.file === finding.file && finding.match.includes(exception.pattern),
  );
  if (!entry) return true;
  honoured.add(entry);
  return false;
});

for (const entry of KNOWN_EXCEPTIONS) {
  if (honoured.has(entry)) continue;
  failures.push(
    `KNOWN_EXCEPTIONS still excuses "${entry.pattern}" in ${entry.file}, which no longer matches anything. `
    + "The reference is gone or the file moved — delete the entry so the list keeps describing the tree.",
  );
}

// -------------------------------------------------------- 6. vacuity floors ---

if (manifests.length < MINIMUM_MANIFESTS) {
  failures.push(
    `${manifests.length} manifests scanned is below the ${MINIMUM_MANIFESTS} floor — `
    + "the file listing is probably broken, and a broken listing reports a clean tree",
  );
}
if (sources.length < MINIMUM_SOURCE_FILES) {
  failures.push(
    `${sources.length} source files scanned is below the ${MINIMUM_SOURCE_FILES} floor — `
    + "the file listing is probably broken, and a broken listing reports a clean tree",
  );
}
if (lockResolutions < MINIMUM_LOCK_RESOLUTIONS && (tracked.includes("bun.lock") || !fixtureFloors)) {
  failures.push(
    `${lockResolutions} lockfile resolutions parsed is below the ${MINIMUM_LOCK_RESOLUTIONS} floor — `
    + "bun.lock's format has probably moved and the resolution matcher no longer reads it",
  );
}

// ------------------------------------------------------------------ verdict ---

if (unexcused.length > 0 || failures.length > 0) {
  console.error("MongoDB reintroduction guard failed:\n");
  for (const finding of unexcused) {
    console.error(`  ${finding.file}:${finding.line}: ${finding.rule}`);
    console.error(`    ${finding.match}\n`);
  }
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    "  Mention is PostgreSQL-only (issue #706); reintroducing Mongo needs an explicit architectural\n"
    + "  decision — remove the reference or add a reasoned KNOWN_EXCEPTIONS entry.\n",
  );
  process.exit(1);
}

console.log(
  `MongoDB reintroduction guard passed — ${manifests.length} manifests, ${sources.length} source files, `
  + `${configs.length} config files and ${lockResolutions} lockfile resolutions scanned; `
  + `${honoured.size} of ${KNOWN_EXCEPTIONS.length} known exceptions honoured.`,
);
