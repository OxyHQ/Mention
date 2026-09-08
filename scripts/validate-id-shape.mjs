#!/usr/bin/env bun

/**
 * An Oxy id's SHAPE is not a fact this repository is allowed to depend on.
 *
 * ## What went wrong, once, in five places at the same time
 *
 * oxy-api minted Mongo ObjectIds until its Postgres cutover on 2026-07-31; every
 * id it has minted since is a uuid v7, and the ids that existed before came
 * across verbatim. Five gates here were written as `/^[a-f0-9]{24}$/`, and none
 * of them failed, threw, or logged when that stopped being true. They just began
 * answering "no" for every account and asset created after that date:
 *
 *   - media enrichment stopped asking Oxy about new uploads, so `post_media`
 *     kept NULL dimensions — and the Videos lane requires `width > 0 AND
 *     height > 0`, so those videos were absent from it rather than mis-sized;
 *   - notification rows stopped resolving their actor's name and avatar;
 *   - the platform purge rejected a valid cursor as a malformed response.
 *
 * A wrong answer that looks like a legitimate "no" is the worst failure mode a
 * check can have, and an id pattern is a machine for producing them.
 *
 * ## The rule
 *
 * RECOGNISING an id by its shape is banned. Deciding is done by asking the
 * question the data can answer:
 *
 *   - a media reference is an Oxy file id or an `http(s)` URL, so ask whether it
 *     is a URL (`utils/mediaResolver.ts` `isAbsoluteHttpUrl`) — the alternative
 *     is self-describing and cannot go stale;
 *   - a notification actor id is present or absent, so ask THAT (the column is
 *     `text NOT NULL` and holds an Oxy account id; the frontend used to
 *     substitute the string `'unknown'`, which is what forced every consumer to
 *     re-derive "is this real?" from the text);
 *   - a cursor from another service is OPAQUE, so check that there is one, not
 *     what it looks like.
 *
 * REDACTING an id from text is different and stays allowed: a log line is
 * untyped text, the id has no field to be absent from, and matching it is the
 * only way to keep it out. Those sites are allow-listed below, one entry each.
 *
 * ## What it scans for
 *
 *   1. A 24-hex character class — the ObjectId shape, in any of its spellings.
 *   2. A uuid regex that PINS the version nibble. `[1-5]` is how both log
 *      redactors silently stopped matching our own ids (they are v7), and a
 *      pattern pinned to `7` is no better as a recogniser: it excludes every
 *      pre-cutover id, and it excludes whatever version comes next.
 *   3. `ObjectId.isValid` / `isValidObjectId` — the same assumption, imported.
 *
 * Tests are exempt: a test asserting that `generatedId()` produces a v7 uuid is
 * a claim about what we MINT, which is exactly the fact worth pinning, and the
 * suites that seed a legacy id to prove both shapes still work need to write one
 * down. Markdown is exempt everywhere — the history of the migration belongs in
 * prose.
 *
 * Usage:  bun scripts/validate-id-shape.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = process.env.ID_SHAPE_VALIDATOR_ROOT
  ? resolve(process.env.ID_SHAPE_VALIDATOR_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Fixture trees are tiny, so the self-test lowers the vacuity floor rather than removing it. */
const fixtureFloors = process.env.ID_SHAPE_VALIDATOR_FIXTURE_FLOORS === "1";

/** The minimum number of files a healthy scan sees. A traversal that breaks reports a clean tree. */
const MINIMUM_FILES_SCANNED = fixtureFloors ? 1 : 400;

const RULES = [
  {
    name: "objectid-shape",
    // `[a-f0-9]{24}`, `[0-9a-fA-F]{24}`, and every other spelling of the same
    // class. Anchors and flags vary; the class and the count do not.
    pattern: /\[(?:0-9a-fA-F|a-fA-F0-9|0-9a-f|a-f0-9|A-F0-9|0-9A-F)\]\{24\}/g,
    message:
      "a 24-hex id pattern — Oxy stopped minting ObjectIds on 2026-07-31, so this " +
      "answers 'no' for everything created since. Ask what the data can answer " +
      "(is it a URL, is it present) instead of what the id looks like.",
  },
  {
    name: "uuid-version-pin",
    // A uuid regex whose version nibble is anything narrower than "any hex".
    pattern: /\[0-9a-fA-F\]\{4\}-(?:\[[0-9]-[0-9]\]|[0-9])\[|\[0-9a-f\]\{4\}-(?:\[[0-9]-[0-9]\]|[0-9])\[/g,
    message:
      "a uuid pattern pinned to a version nibble. Ours are v7 and the ids before " +
      "them are not uuids at all, so a pinned version recognises the wrong set — " +
      "this is exactly how both log redactors stopped matching our own ids.",
  },
  {
    name: "objectid-validator",
    pattern: /\b(?:ObjectId\.isValid|isValidObjectId)\s*\(/g,
    message:
      "an ObjectId validity check. Mention is Mongo-free and Oxy's ids are uuid " +
      "v7; this rejects every id minted since the cutover.",
  },
];

/**
 * Deliberate, reasoned survivals. Each entry excuses ONE rule in ONE file, and
 * the list may only SHRINK: an entry that stops matching FAILS the run, so a
 * workaround cannot outlive the thing it worked around.
 *
 * Every entry here REDACTS an id out of untyped text. None of them decides
 * whether a value is an id — that is the distinction the rule draws.
 */
const KNOWN_EXCEPTIONS = [
  {
    file: "packages/backend/src/utils/logger.ts",
    rule: "objectid-shape",
    reason:
      "Log redaction. A log line is untyped text and can still carry a pre-cutover id from " +
      "anywhere upstream; matching it is the only way to keep it out of CloudWatch. The uuid " +
      "clause beside it is deliberately version-agnostic.",
  },
  {
    file: "packages/frontend/lib/logging/sanitize.ts",
    rule: "objectid-shape",
    reason:
      "Log redaction, the client half of the same rule and for the same reason.",
  },
  {
    file: "packages/mcp/lib/logger.ts",
    rule: "objectid-shape",
    reason:
      "Log redaction, the MCP server's half of the same rule. Its uuid clause is version-agnostic " +
      "for the same reason the other two now are.",
  },
  {
    file: "packages/backend/src/utils/oxyMetrics.ts",
    rule: "objectid-shape",
    reason:
      "Metric-label redaction: a path segment that is an id must be collapsed before it becomes " +
      "a Prometheus label, and a URL can carry either shape. It matches both, which is the " +
      "point — it is a redactor, not a decision.",
  },
];

/**
 * The source with COMMENTS REMOVED, so the rules read code and not prose.
 *
 * This is not a nicety in this repository. Every site that already removed an id
 * pattern documents it — "this used to gate on `ObjectId.isValid(...)`", "this
 * used to carry its own `/^[a-f0-9]{24}$/`" — and those explanations are the
 * most valuable text in the file. A gate that fired on them would either be
 * turned off or would push people to stop writing them down, which is the same
 * outage arriving later with less to read.
 *
 * A regex-free `stripComments` cannot be written correctly, because `//` inside
 * a string and `/*` inside a regex literal are not comments. So this walks the
 * source once, tracking which of the five states each character is in, and
 * blanks out only the comment ones. Blanking (rather than deleting) keeps every
 * offset intact, so a reported match still points at the right place.
 */
function stripComments(source) {
  const out = source.split("");
  let state = "code";
  let quote = "";
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; out[i] = " "; continue; }
      if (c === "/" && next === "*") { state = "block"; out[i] = " "; continue; }
      if (c === "'" || c === '"' || c === "`") { state = "string"; quote = c; continue; }
      // A `/` that opens a regex literal rather than dividing. The preceding
      // non-space character decides, and the set below is what can END an
      // expression — anything else means the slash starts a pattern.
      if (c === "/") {
        const before = source.slice(0, i).trimEnd();
        const prev = before[before.length - 1] ?? "";
        if (!/[\w$)\]]/.test(prev)) { state = "regex"; continue; }
      }
      continue;
    }
    if (state === "line") {
      out[i] = c === "\n" ? c : " ";
      if (c === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      const closing = c === "*" && next === "/";
      out[i] = c === "\n" ? c : " ";
      if (closing) { out[i + 1] = " "; i += 1; state = "code"; }
      continue;
    }
    if (state === "string") {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) { state = "code"; quote = ""; }
      continue;
    }
    if (state === "regex") {
      if (c === "\\") { i += 1; continue; }
      if (c === "/") state = "code";
      else if (c === "\n") state = "code";
      continue;
    }
  }
  return out.join("");
}

function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "-z", "packages"], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr?.toString() ?? "unknown error"}`);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

/** Source we hold to the rule: TypeScript, excluding tests and generated output. */
function isScannedSource(path) {
  if (!/\.(?:ts|tsx)$/.test(path)) return false;
  if (path.includes("/node_modules/") || path.includes("/dist/")) return false;
  if (path.includes("/__tests__/") || /\.test\.tsx?$/.test(path)) return false;
  if (path.endsWith(".generated.ts")) return false;
  // `git ls-files` reads the INDEX, which still lists a file deleted in the
  // working tree until the deletion is staged. Scanning is about the tree in
  // front of us, so a path with no file is not a finding and not an error.
  return existsSync(resolve(repositoryRoot, path));
}

const files = trackedFiles().filter(isScannedSource);
const failures = [];
const matchedExceptions = new Set();

for (const file of files) {
  const source = stripComments(await readFile(resolve(repositoryRoot, file), "utf8"));
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const hits = source.match(rule.pattern);
    if (!hits) continue;

    const exception = KNOWN_EXCEPTIONS.find(
      (entry) => entry.file === file && entry.rule === rule.name,
    );
    if (exception) {
      matchedExceptions.add(`${exception.file}::${exception.rule}`);
      continue;
    }
    failures.push(`${file}: ${rule.message} (matched ${JSON.stringify(hits[0])})`);
  }
}

for (const entry of KNOWN_EXCEPTIONS) {
  if (!matchedExceptions.has(`${entry.file}::${entry.rule}`)) {
    failures.push(
      `${entry.file}: the allow-list entry for "${entry.rule}" no longer matches anything. ` +
        "Delete it — an exception that outlives its cause hides the next one.",
    );
  }
}

if (files.length < MINIMUM_FILES_SCANNED) {
  failures.push(
    `only ${files.length} source file(s) were scanned (floor ${MINIMUM_FILES_SCANNED}). ` +
      "A traversal that finds nothing reports a clean tree, which is the one answer this " +
      "gate must never give by accident.",
  );
}

if (failures.length > 0) {
  console.error("Id-shape assumptions found:\n");
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nAn id pattern answers 'no' for the ids Oxy mints today. Ask what the data can answer:\n" +
      "  - a media ref is an Oxy file id or an http(s) URL — test the URL;\n" +
      "  - an actor id is present or absent — test presence;\n" +
      "  - another service's cursor is opaque — test that there is one.\n" +
      "If the site genuinely REDACTS an id from untyped text, add a reasoned KNOWN_EXCEPTIONS entry.",
  );
  process.exit(1);
}

console.log(
  `No id-shape assumptions in ${files.length} source file(s); ` +
    `${KNOWN_EXCEPTIONS.length} reasoned redaction exception(s), all still matching.`,
);
