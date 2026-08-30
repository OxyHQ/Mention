#!/usr/bin/env bun

/**
 * Mutation-tests `validate-architecture-boundaries.mjs`.
 *
 * A default-deny guard that has only ever been seen to PASS is worse than no
 * guard, because it looks like protection. Every input to this one is a file
 * listing or a regex, and both fail quiet: a broken `git ls-files` reports a
 * clean tree, and so does a regex that silently stopped matching. Each case
 * below breaks exactly one thing and requires the guard to fail with the words
 * that identify the right rule.
 *
 * The cases that must PASS matter as much. Rule 2 deliberately allows type-only
 * imports, services reaching into `db/`, and the non-controller half of
 * `src/mtn/`; a version that fired on any of those would be widened by whoever
 * hit it first until it stopped meaning anything.
 *
 * Fixtures are real trees with a real `git init`, so the guard's own file
 * listing runs rather than a stand-in for it. The filler that makes a fixture
 * tree "clean" is GENERATED from the guard's live baselines — the same coupling
 * `test-validate-no-mongo.mjs` uses on purpose, and for the same reason: the
 * self-test then proves the real entries describe real crossings. Adding a
 * baseline entry costs nothing here; the filler follows automatically.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASELINE,
  LAYER_BASELINE,
  PROTOCOLS,
  baselineShapeFailures,
} from "./validate-architecture-boundaries.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-architecture-boundaries.mjs");

/** A relative specifier from one repo-relative source file to another. */
function specifierFrom(importer, target) {
  const from = importer.split("/").slice(0, -1);
  const to = target.replace(/\.ts$/, "").split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;
  const up = from.length - shared;
  const hops = up === 0 ? ["."] : Array.from({ length: up }, () => "..");
  return [...hops, ...to.slice(shared)].join("/");
}

/**
 * The module a baseline entry's crossing points AT.
 *
 * Rule 1's entries name a protocol, so any file inside that protocol's
 * directory other than its public entry will do. Rule 2's entries name a db
 * area, which is either a directory (pick a file in it) or already a file.
 */
function targetOf(entry) {
  if (entry.protocol) {
    const protocol = PROTOCOLS.find((candidate) => candidate.id === entry.protocol);
    if (!protocol) throw new Error(`baseline names an unknown protocol: ${entry.protocol}`);
    return `${protocol.dir}baselineFixtureInternal.ts`;
  }
  return entry.area.endsWith("/") ? `${entry.area}baselineFixtureModule.ts` : entry.area;
}

/**
 * A tree in which every live baseline entry matches something, and nothing else
 * crosses either boundary. `skipBaselineFiles` omits an importer so its entries
 * go stale, which is the only way to exercise the shrink-only property.
 */
function filler(extra = {}, { skipBaselineFiles = [] } = {}) {
  const skipped = new Set(skipBaselineFiles);
  const imports = new Map();
  const targets = new Set();

  for (const entry of [...BASELINE, ...LAYER_BASELINE]) {
    if (skipped.has(entry.file)) continue;
    const target = targetOf(entry);
    targets.add(target);
    const lines = imports.get(entry.file) ?? [];
    lines.push(`import { fixtureValue } from '${specifierFrom(entry.file, target)}';`);
    imports.set(entry.file, lines);
  }

  const files = {
    "package.json": `${JSON.stringify({ name: "architecture-boundary-fixture" }, null, 2)}\n`,
  };
  for (const [file, lines] of imports) {
    files[`packages/backend/${file}`] = `${lines.join("\n")}\nexport const handler = () => fixtureValue;\n`;
  }
  for (const target of targets) {
    files[`packages/backend/${target}`] = "export const fixtureValue = 1;\n";
  }
  for (const [path, contents] of Object.entries(extra)) {
    files[`packages/backend/${path}`] = contents;
  }
  return files;
}

/** Run the REAL validator against a scratch checkout. */
async function runAgainst(files, { realFloors = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "architecture-boundary-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }
    // `-f` because a developer's global excludes file can legitimately ignore a
    // path shape used here, and a dropped fixture passes for the wrong reason.
    Bun.spawnSync({ cmd: ["git", "-c", "init.defaultBranch=main", "init", "-q"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "add", "-A", "-f"], cwd: root });

    const environment = { ...process.env, ARCHITECTURE_VALIDATOR_ROOT: root };
    if (!realFloors) environment.ARCHITECTURE_VALIDATOR_FIXTURE_FLOORS = "1";

    const proc = Bun.spawnSync({
      cmd: ["bun", validator],
      cwd: repositoryRoot,
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: proc.exitCode, output: `${proc.stdout.toString()}${proc.stderr.toString()}` };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** An importer whose LAYER_BASELINE entries do NOT cover `src/db/postgres.ts`. */
const baselinedWithoutQuerySurface = LAYER_BASELINE.find(
  (entry) => !LAYER_BASELINE.some(
    (other) => other.file === entry.file && other.area === "src/db/postgres.ts",
  ),
);
if (!baselinedWithoutQuerySurface) {
  throw new Error(
    "every baselined route/controller already reaches src/db/postgres.ts — "
    + "the 'existing file, new area' case can no longer be written; rewrite it against another area",
  );
}

const cases = [
  {
    name: "a tree carrying exactly the baselined crossings passes",
    files: filler(),
    expectFailure: false,
  },

  // ------------------------------------------- rule 2: default-deny bites ---
  {
    name: "a NEW route reaching into db/ fails",
    files: filler({
      "src/routes/brandNew.routes.ts":
        "import { getDb } from '../db/postgres';\nexport const rows = () => getDb();\n",
    }),
    expectFailure: true,
    expectOutput: "src/routes/brandNew.routes.ts: reaches into the raw query surface at src/db/postgres.ts",
  },
  {
    name: "a NEW controller reaching into db/ fails",
    files: filler({
      "src/controllers/brandNew.controller.ts":
        "import { findPostRecords } from '../db/posts/postRepository';\nexport const read = findPostRecords;\n",
    }),
    expectFailure: true,
    expectOutput: "src/controllers/brandNew.controller.ts: reaches into a repository at src/db/posts/",
  },
  {
    // The finer half of the granularity decision. Per-file baselining would let
    // this through: the file is already excused for a DIFFERENT area.
    name: "an ALREADY-baselined file reaching into a NEW db area fails",
    files: filler({
      [baselinedWithoutQuerySurface.file]: `${
        filler()[`packages/backend/${baselinedWithoutQuerySurface.file}`]
      }import { getDb } from '${specifierFrom(baselinedWithoutQuerySurface.file, "src/db/postgres.ts")}';\n`
        + "export const rows = () => getDb();\n",
    }),
    expectFailure: true,
    expectOutput: `${baselinedWithoutQuerySurface.file}: reaches into the raw query surface at src/db/postgres.ts`,
  },
  {
    name: "a dynamic import() of a db module from a new route fails",
    files: filler({
      "src/routes/lazy.routes.ts":
        "export const rows = async () => (await import('../db/postgres')).getDb();\n",
    }),
    expectFailure: true,
    expectOutput: "src/routes/lazy.routes.ts: reaches into the raw query surface",
  },
  {
    // The schema decision, stated as a test. `schema/` is "just table
    // definitions", and exempting it is the argument that lets `getDb()`
    // follow. A drizzle table is a value; a route holding one is a query.
    name: "a schema table import is a violation, reported as the raw query surface",
    files: filler({
      "src/routes/schemaOnly.routes.ts":
        "import { posts } from '../db/schema/posts';\nexport const table = posts;\n",
    }),
    expectFailure: true,
    expectOutput: "reaches into the raw query surface at src/db/schema/",
  },
  {
    name: "src/mtn/controllers IS in scope",
    files: filler({
      "src/mtn/controllers/brandNew.controller.ts":
        "import { getDb } from '../../db/postgres';\nexport const rows = () => getDb();\n",
    }),
    expectFailure: true,
    expectOutput: "src/mtn/controllers/brandNew.controller.ts: reaches into the raw query surface",
  },

  // ------------------------------------------- rule 2: what must NOT fire ---
  {
    // The distinguishing shape for the type-only decision. Without it,
    // `isTypeOnlyClause` returning a constant `false` passes every other case
    // in this file, so the allowance would be an untested claim.
    name: "a type-only import into db/ from a NEW route passes",
    files: filler({
      "src/routes/typeOnly.routes.ts":
        "import type { PostRecord } from '../db/posts/postRecord';\n"
        + "export const describe = (record: PostRecord) => record;\n",
    }),
    expectFailure: false,
  },
  {
    // The regression the `^`-anchored, semicolon-bounded clause exists for. A
    // greedy scan starts at the `express` import and runs to the first RELATIVE
    // specifier, so it reads this clause as `{ Router }` — a value — and
    // reports a violation that is not there. Measured on the real tree: two of
    // the five type-only db imports were misclassified before the anchor.
    name: "a type-only import FOLLOWING a bare-package import is still type-only",
    files: filler({
      "src/routes/afterPackage.routes.ts":
        "import { Router } from 'express';\n"
        + "import type { PostRecord } from '../db/posts/postRecord';\n"
        + "export const router = (record: PostRecord) => [Router, record];\n",
    }),
    expectFailure: false,
  },
  {
    // The other half of the type-only decision: an import is only free when it
    // binds NOTHING at runtime. One value among the types is still a value.
    name: "a MIXED import naming one value beside a type FAILS",
    files: filler({
      "src/routes/mixed.routes.ts":
        "import { insertLane, type LaneRow } from '../db/channels/laneRepository';\n"
        + "export const add = (row: LaneRow) => insertLane(row);\n",
    }),
    expectFailure: true,
    expectOutput: "src/routes/mixed.routes.ts: reaches into a repository at src/db/channels/",
  },
  {
    // The intended path. A rule that fired here would forbid the architecture
    // it is trying to enforce.
    name: "a SERVICE reaching into db/ passes — that is the intended path",
    files: filler({
      "src/services/BrandNewService.ts":
        "import { getDb } from '../db/postgres';\nexport const rows = () => getDb();\n",
    }),
    expectFailure: false,
  },
  {
    name: "the non-controller half of src/mtn is NOT in scope",
    files: filler({
      "src/mtn/feed/BrandNewFeed.ts":
        "import { getDb } from '../../db/postgres';\nexport const rows = () => getDb();\n",
    }),
    expectFailure: false,
  },
  {
    name: "a test file beside a route is not policed",
    files: filler({
      "src/routes/__tests__/brandNew.test.ts":
        "import { getDb } from '../../db/postgres';\nit('reads', () => getDb());\n",
    }),
    expectFailure: false,
  },

  // ------------------------------------------------ shrink-only discipline ---
  {
    name: "a LAYER_BASELINE entry that matches nothing FAILS the run",
    files: filler({}, { skipBaselineFiles: [LAYER_BASELINE[0].file] }),
    expectFailure: true,
    expectOutput: `LAYER_BASELINE entry for ${LAYER_BASELINE[0].file}`,
  },
  {
    name: "a stale LAYER_BASELINE entry says the crossing was fixed, and to delete it",
    files: filler({}, { skipBaselineFiles: [LAYER_BASELINE[0].file] }),
    expectFailure: true,
    expectOutput: "no longer matches anything — the crossing was fixed",
  },
  {
    name: "a BASELINE (rule 1) entry that matches nothing FAILS the run",
    files: filler({}, { skipBaselineFiles: [BASELINE[0].file] }),
    expectFailure: true,
    expectOutput: `BASELINE entry for ${BASELINE[0].file}`,
  },

  // ------------------------------------------- rule 1 still does its job ---
  {
    name: "a NEW service reaching into a protocol internal fails",
    files: filler({
      "src/services/BrandNewFederation.ts":
        "import { ACTIVITY_STREAMS_CONTEXT } from '../connectors/activitypub/constants';\n"
        + "export const context = ACTIVITY_STREAMS_CONTEXT;\n",
    }),
    expectFailure: true,
    expectOutput: "src/services/BrandNewFederation.ts: imports activitypub internal",
  },
  {
    name: "a NEW service reaching the PUBLIC connector entry passes",
    files: filler({
      "src/services/BrandNewFederation.ts":
        "import { ActivityPubConnector } from '../connectors/activitypub/ActivityPubConnector';\n"
        + "export const connector = ActivityPubConnector;\n",
    }),
    expectFailure: false,
  },

  // ------------------------------------------------------- vacuity floors ---
  {
    name: "a broken file listing cannot pass silently (source-file floor)",
    files: {
      "package.json": '{ "name": "architecture-boundary-fixture" }\n',
      "packages/backend/src/db/postgres.ts": "export const getDb = () => null;\n",
    },
    realFloors: true,
    expectFailure: true,
    expectOutput: "below the 400 floor",
  },
  {
    name: "a listing with no route/controller files cannot pass silently",
    files: {
      "package.json": '{ "name": "architecture-boundary-fixture" }\n',
      "packages/backend/src/db/postgres.ts": "export const getDb = () => null;\n",
    },
    realFloors: true,
    expectFailure: true,
    expectOutput: "route/controller files scanned is below the 40 floor",
  },
  {
    name: "a listing with no db/ modules cannot pass silently",
    files: {
      "package.json": '{ "name": "architecture-boundary-fixture" }\n',
      "packages/backend/src/routes/only.routes.ts": "export const handler = () => null;\n",
    },
    realFloors: true,
    expectFailure: true,
    expectOutput: "is below the 30 floor",
  },
];

let failed = 0;

// The reason-shape check reads the guard's own constants, not the tree, so no
// fixture can reach it — the placeholder `--print-layer-baseline` emits for a
// new pair resolves to `undefined`, and this is what refuses it. Exercised
// directly instead, with a positive control either side.
for (const [name, entries, expectRejected] of [
  ["the live baselines all carry a reason", [...BASELINE, ...LAYER_BASELINE], false],
  ["an entry with an undefined reason is refused", [{ file: "src/routes/x.ts", area: "src/db/posts/" }], true],
  ["an entry with a blank reason is refused", [{ file: "src/routes/x.ts", area: "src/db/posts/", reason: "  " }], true],
]) {
  const rejected = baselineShapeFailures("LAYER_BASELINE", entries).length > 0;
  if (rejected !== expectRejected) {
    console.error(`FAIL ${name}: baselineShapeFailures returned ${rejected ? "a failure" : "nothing"}`);
    failed += 1;
  } else {
    console.log(`ok   ${name}`);
  }
}

for (const testCase of cases) {
  const { exitCode, output } = await runAgainst(testCase.files, { realFloors: testCase.realFloors === true });
  const didFail = exitCode !== 0;

  if (didFail !== testCase.expectFailure) {
    console.error(
      `FAIL ${testCase.name}: expected ${testCase.expectFailure ? "a failure" : "a pass"}, `
      + `got exit ${exitCode}\n${output}`,
    );
    failed += 1;
    continue;
  }
  if (testCase.expectOutput && !output.includes(testCase.expectOutput)) {
    console.error(
      `FAIL ${testCase.name}: failed as expected, but the message never said `
      + `"${testCase.expectOutput}"\n${output}`,
    );
    failed += 1;
    continue;
  }
  console.log(`ok   ${testCase.name}`);
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length + 3} guard cases failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length + 3} guard cases passed.`);
