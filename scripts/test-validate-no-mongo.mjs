#!/usr/bin/env bun

/**
 * Mutation-tests `validate-no-mongo.mjs`.
 *
 * A guard that has only ever been seen to pass is indistinguishable from one
 * that cannot fail — and this one is especially easy to break silently, because
 * every part of it is a regex or a file listing and both fail QUIET. A broken
 * `git ls-files` reports a clean tree. A regex with a typo reports a clean tree.
 * Each case below breaks exactly one thing and requires the guard to fail, and
 * to fail with the words that identify the right rule.
 *
 * The cases that must PASS matter as much: this repository's comments discuss
 * Mongo constantly, on purpose, and both loggers carry a Mongo-URI redaction
 * pattern that is wanted. A version of this guard that fired on either would be
 * disabled by whoever hit it first.
 *
 * Fixtures are real trees with a real `git init`, so the guard's actual file
 * listing runs rather than a stand-in for it.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-no-mongo.mjs");

/**
 * Run the REAL validator against a scratch checkout.
 *
 * `realFloors` runs it with production vacuity floors, which is the only way to
 * see them fire; every other case relaxes them, since a fixture tree of six
 * files would otherwise fail for a reason that has nothing to do with Mongo.
 */
async function runAgainst(files, { realFloors = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "no-mongo-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }

    // `-f` because a developer's global excludes file can legitimately ignore
    // `*.lock`, which would drop the lockfile fixture and make its case pass for
    // the wrong reason.
    Bun.spawnSync({ cmd: ["git", "-c", "init.defaultBranch=main", "init", "-q"], cwd: root });
    Bun.spawnSync({ cmd: ["git", "add", "-A", "-f"], cwd: root });

    const environment = { ...process.env, NO_MONGO_VALIDATOR_ROOT: root };
    if (!realFloors) environment.NO_MONGO_VALIDATOR_FIXTURE_FLOORS = "1";

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
 * A clean tree.
 *
 * It carries one file per live `KNOWN_EXCEPTIONS` entry, holding the text that
 * entry excuses — so every case below also exercises the exception path, and the
 * guard's "the list must only shrink" check has something to be satisfied by.
 * The stale-exception case is the one tree that deliberately omits it.
 *
 * THIS IS COUPLED TO THE LIVE LIST ON PURPOSE, and the coupling is the point:
 * the self-test then proves the real exceptions match real text, rather than
 * proving a synthetic list matches synthetic text. Adding an entry to the guard
 * means adding its file here; forgetting turns every case below red with a
 * message naming the entry. The cost shrinks as the list does.
 */
function filler(extra = {}) {
  return {
    "package.json": `${JSON.stringify(
      {
        name: "fixture",
        workspaces: { packages: ["packages/*"], catalog: { typescript: "~5.9.3" } },
        dependencies: { postgres: "3.4.9" },
        overrides: { ioredis: "5.11.1" },
      },
      null,
      2,
    )}\n`,
    "bun.lock": [
      "{",
      '  "lockfileVersion": 1,',
      '  "packages": {',
      '    "postgres": ["postgres@3.4.9", "", {}, "sha512-fixture=="],',
      '    "drizzle-orm": ["drizzle-orm@0.45.2", "", {}, "sha512-fixture=="],',
      "  },",
      "}",
      "",
    ].join("\n"),
    "packages/backend/src/db/postgres.ts": "export const dialect = 'postgres';\n",
    "packages/backend/src/__tests__/utils/loggerSanitization.test.ts":
      "it('redacts a database URI', () => {\n"
      + "  expect(sanitise('mongodb://alice:password@host/mention')).toBe('[REDACTED]');\n"
      + "});\n",
    ...extra,
  };
}

const cases = [
  {
    name: "a clean PostgreSQL-only tree passes",
    files: filler(),
    expectFailure: false,
  },

  // ------------------------------------------------------------ manifests ---
  {
    name: "a dependency on mongoose is rejected",
    files: filler({
      "packages/backend/package.json": `${JSON.stringify(
        { name: "@mention/backend", dependencies: { mongoose: "^8.24.0" } },
        null,
        2,
      )}\n`,
    }),
    expectFailure: true,
    expectOutput: "dependencies declares mongoose",
  },
  {
    name: "a devDependency on mongodb-memory-server is rejected",
    files: filler({
      "packages/backend/package.json": `${JSON.stringify(
        { name: "@mention/backend", devDependencies: { "mongodb-memory-server": "^10.0.0" } },
        null,
        2,
      )}\n`,
    }),
    expectFailure: true,
    expectOutput: "devDependencies declares mongodb-memory-server",
  },
  {
    name: "a catalog entry is rejected",
    files: filler({
      "package.json": `${JSON.stringify(
        { name: "fixture", workspaces: { packages: ["packages/*"], catalog: { mongodb: "^6.10.0" } } },
        null,
        2,
      )}\n`,
    }),
    expectFailure: true,
    expectOutput: "workspaces.catalog declares mongodb",
  },
  {
    name: "an override is rejected",
    files: filler({
      "package.json": `${JSON.stringify({ name: "fixture", overrides: { mongoose: "8.24.0" } }, null, 2)}\n`,
    }),
    expectFailure: true,
    expectOutput: "overrides declares mongoose",
  },
  {
    // The regression this check exists for. `@mention/backend` described itself
    // as an "Express 5 / Mongoose / Socket.io backend" while every dependency
    // check above passed, because a description declares nothing. The most
    // visible line in the manifest was the one the guard could not read.
    name: "a description claiming Mongoose is rejected",
    files: filler({
      "packages/backend/package.json": `${JSON.stringify(
        { name: "@mention/backend", description: "Express 5 / Mongoose / Socket.io backend for Mention" },
        null,
        2,
      )}\n`,
    }),
    expectFailure: true,
    expectOutput: "description claims Mongoose",
  },
  {
    name: "a keyword claiming MongoDB is rejected",
    files: filler({
      "packages/backend/package.json": `${JSON.stringify(
        { name: "@mention/backend", keywords: ["api", "MongoDB"] },
        null,
        2,
      )}\n`,
    }),
    expectFailure: true,
    expectOutput: "keywords claims MongoDB",
  },
  {
    // The distinguishing shape for the word anchor. A substring match would
    // reject both of these, and a maintainer who hit that would delete the
    // check rather than argue with it — a gate that cries wolf gets disabled by
    // whoever trips over it next. Without this fixture, `/mongo/i` and
    // `/\bmongo(?:db|ose)?\b/i` are indistinguishable.
    name: "a description containing mongo inside another word passes",
    files: filler({
      "packages/backend/package.json": `${JSON.stringify(
        { name: "@mention/backend", description: "Ranked among the fastest, deployed in Mongolia" },
        null,
        2,
      )}\n`,
    }),
    expectFailure: false,
  },

  // ------------------------------------------------------------- lockfile ---
  {
    name: "a lockfile resolution is rejected even with clean manifests",
    files: filler({
      "bun.lock": [
        "{",
        '  "lockfileVersion": 1,',
        '  "packages": {',
        '    "postgres": ["postgres@3.4.9", "", {}, "sha512-fixture=="],',
        '    "mongoose": ["mongoose@8.24.0", "", { "dependencies": { "mongodb": "6.10.0" } }, "sha512-fixture=="],',
        "  },",
        "}",
        "",
      ].join("\n"),
    }),
    expectFailure: true,
    expectOutput: "resolves mongoose",
  },
  {
    name: "a NESTED lockfile resolution is rejected too",
    files: filler({
      "bun.lock": [
        "{",
        '  "lockfileVersion": 1,',
        '  "packages": {',
        '    "postgres": ["postgres@3.4.9", "", {}, "sha512-fixture=="],',
        '    "@some/pkg/mongodb": ["mongodb@6.10.0", "", {}, "sha512-fixture=="],',
        "  },",
        "}",
        "",
      ].join("\n"),
    }),
    expectFailure: true,
    expectOutput: "resolves mongodb",
  },
  {
    name: "a package whose NAME merely contains a banned one is not rejected",
    files: filler({
      "bun.lock": [
        "{",
        '  "lockfileVersion": 1,',
        '  "packages": {',
        '    "mongoose-helper": ["mongoose-helper@1.0.0", "", {}, "sha512-fixture=="],',
        '    "not-mongodb": ["not-mongodb@2.0.0", "", {}, "sha512-fixture=="],',
        "  },",
        "}",
        "",
      ].join("\n"),
    }),
    expectFailure: false,
  },

  // -------------------------------------------------------- source imports ---
  {
    name: "an import statement is rejected",
    files: filler({
      "packages/backend/src/db/legacy.ts":
        "import mongoose from 'mongoose';\nexport const connect = () => mongoose.connect('');\n",
    }),
    expectFailure: true,
    expectOutput: "imports a Mongo driver",
  },
  {
    name: "a require call is rejected",
    files: filler({
      "packages/backend/src/db/legacy.cjs": "const { MongoClient } = require('mongodb');\nmodule.exports = MongoClient;\n",
    }),
    expectFailure: true,
    expectOutput: "imports a Mongo driver",
  },
  {
    name: "a dynamic import is rejected",
    files: filler({
      "packages/backend/src/db/legacy.ts":
        'export const boot = async () => (await import("mongodb-memory-server")).MongoMemoryServer;\n',
    }),
    expectFailure: true,
    expectOutput: "imports a Mongo driver",
  },
  {
    name: "a subpath import is rejected",
    files: filler({
      "packages/backend/src/db/legacy.ts": "import { Schema } from 'mongoose/lib/schema';\nexport { Schema };\n",
    }),
    expectFailure: true,
    expectOutput: "imports a Mongo driver",
  },

  // ------------------------------------------------------- config and env ---
  {
    name: "MONGODB_URI in a workflow is rejected",
    files: filler({
      ".github/workflows/deploy.yml": "jobs:\n  deploy:\n    env:\n      MONGODB_URI: ${{ secrets.MONGODB_URI }}\n",
    }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },
  {
    name: "MONGODB_URI in an env template is rejected",
    files: filler({ "packages/backend/.env.example": "DATABASE_URL=\nMONGODB_URI=\n" }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },
  {
    name: "MONGODB_URI in a .github shell script is rejected",
    files: filler({ ".github/scripts/deploy.sh": "#!/usr/bin/env bash\naws ssm get-parameter --name MONGODB_URI\n" }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },
  {
    // The distinguishing shape for the case-insensitive read. Without a fixture
    // in a casing other than the canonical one, a case-SENSITIVE regex passes
    // every other case in this file too, so the difference would go untested.
    name: "a lowercased mongodb_uri config key is rejected",
    files: filler({
      "packages/backend/src/config/legacy.ts": "export const keys = { mongodb_uri: process.env.DATABASE_URL };\n",
    }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },
  {
    name: "a suffixed MONGODB_URI_LEGACY is rejected",
    files: filler({ ".github/workflows/deploy.yml": "env:\n  MONGODB_URI_LEGACY: ${{ secrets.OLD }}\n" }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },
  {
    name: "a mongodb:// connection string in a source file is rejected",
    files: filler({
      "packages/backend/src/db/legacy.ts": "export const uri = 'mongodb://localhost:27017/mention';\n",
    }),
    expectFailure: true,
    expectOutput: "carries a mongodb:// connection string",
  },
  {
    name: "a mongodb+srv:// connection string in a compose file is rejected",
    files: filler({
      "docker-compose.yml": "services:\n  api:\n    environment:\n      - URI=mongodb+srv://user:pw@cluster/mention\n",
    }),
    expectFailure: true,
    expectOutput: "carries a mongodb:// connection string",
  },

  // ------------------------------------------ prose and redaction are safe ---
  {
    name: "backticked prose about Mongo does NOT fire",
    files: filler({
      "packages/backend/src/db/postgres.ts":
        "/**\n"
        + " * Replaces the old `import mongoose from mongoose` boot path. Every model that\n"
        + " * used Mongoose now goes through drizzle; nothing requires mongodb any more,\n"
        + " * and the Mongo connection string this once read is gone.\n"
        + " */\n"
        + "export const dialect = 'postgres';\n",
    }),
    expectFailure: false,
  },
  {
    // The distinguishing shape for the `from|require|import` prefix. Backticked
    // prose is caught by the QUOTE anchor alone, so without a quoted module name
    // outside import position, deleting the prefix entirely leaves every case
    // green — measured. This is the input that tells the two apart.
    name: "a QUOTED module name that is not an import does NOT fire",
    files: filler({
      "packages/backend/src/db/postgres.ts":
        "// Nothing in this package loads 'mongoose' any more; the driver key was\n"
        + '// "mongodb" and both are gone. Kept as a note for anyone grepping.\n'
        + "export const driver = 'postgres';\n",
    }),
    expectFailure: false,
  },
  {
    // The guard names every banned package and both URI shapes by necessity, and
    // this file carries a fixture for each. Scanned, the pair reports itself on
    // every run — which is exactly what happened the moment they were first
    // committed and became visible to `git ls-files`.
    name: "the guard's own source and self-test are not their own subject",
    files: filler({
      "scripts/validate-no-mongo.mjs":
        "const BANNED = ['mongoose', 'mongodb', 'connect-mongo'];\n"
        + "const URI = /\\bmongodb(?:\\+srv)?:\\/\\//i;\n"
        + "const ENV = /\\bMONGODB_URI/i;\n",
      "scripts/test-validate-no-mongo.mjs":
        "const fixture = \"const { MongoClient } = require('mongodb');\";\n"
        + "const uri = 'mongodb://localhost:27017/mention';\n"
        + "const env = 'MONGODB_URI=';\n",
    }),
    expectFailure: false,
  },
  {
    name: "the loggers' Mongo-URI REDACTION pattern does NOT fire",
    files: filler({
      "packages/backend/src/utils/logger.ts":
        "const REDACT = /\\b(?:https?|wss?|redis|rediss|mongodb(?:\\+srv)?):\\/\\/[^\\s\"'<>]+/gi;\n"
        + "const SENSITIVE_KEYS = ['mongouri', 'dbname'];\n"
        + "export const sanitise = (line: string) => line.replace(REDACT, '[REDACTED]');\n",
    }),
    expectFailure: false,
  },
  {
    // Markdown's exemption comes from the scan sets — no glob in the guard can
    // match a `.md` path — rather than from an exclusion filter. An explicit
    // filter was written and then deleted, because mutation-testing showed no
    // input could tell the two versions apart. So this case cannot be broken by
    // touching an exclusion; it fires if someone widens the SOURCE_FILE pattern,
    // which is the change that would actually put docs back in scope.
    name: "a markdown file describing the migration does NOT fire",
    files: filler({
      "docs/MONGO-TO-POSTGRES.md":
        "The copier read `MONGODB_URI` (a mongodb://host/db string) and wrote Postgres.\n"
        + "```ts\nimport mongoose from 'mongoose';\n```\n",
      "packages/backend/README.md": "Set MONGODB_URI to nothing — it is gone. Old value: mongodb://localhost:27017.\n",
    }),
    expectFailure: false,
  },

  // --------------------------- the retired standing removal ----------------
  //
  // `TASK_SECRET_REMOVALS: MONGODB_URI` was briefly excused. It named the secret
  // in order to strip it from every rendered task definition, which was load-
  // bearing while a Terraform apply could still reintroduce it — the definition
  // is derived from the LIVE one, so a secret nobody names is carried forward.
  //
  // That threat model closed upstream: oxy-infra `099db84` records DATABASE_URL
  // and no MONGODB_URI for this service, and `/oxy/mention/MONGODB_URI` is
  // deleted from SSM, so a name that comes back now fails task provisioning
  // loudly instead of resurrecting a secret. The directive and its exception are
  // both gone, and the absence assertion lives here instead, in CI.
  //
  // These two cases are what makes that a decision rather than a drift: the
  // retired directive is now an ordinary finding, and so is every other shape a
  // reintroduction would take in that file.
  {
    name: "the retired removal directive is now an ordinary finding",
    files: filler({
      ".github/workflows/deploy-aws.yml": "        env:\n          TASK_SECRET_REMOVALS: MONGODB_URI\n",
    }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },
  {
    // `TASK_SECRET_OVERRIDES_JSON` supplies secrets by SSM path in this file, so
    // an ARN is the other shape a reintroduction would take — and the one a
    // scanner looking only for a bare variable name would miss.
    name: "the deploy workflow FAILS on an SSM ARN for the parameter",
    files: filler({
      ".github/workflows/deploy-aws.yml":
        "        env:\n"
        + '          TASK_SECRET_OVERRIDES_JSON: {"MONGODB_URI":'
        + '"arn:aws:ssm:us-west-2:237343248947:parameter/oxy/mention/MONGODB_URI"}\n',
    }),
    expectFailure: true,
    expectOutput: "names MONGODB_URI",
  },

  // ------------------------------------------------------- self-protection ---
  {
    name: "a broken file listing cannot pass silently (vacuity floors)",
    files: {
      "packages/backend/src/db/postgres.ts": "export const dialect = 'postgres';\n",
      "packages/backend/src/__tests__/utils/loggerSanitization.test.ts": "// mongodb://host/db\n",
    },
    realFloors: true,
    expectFailure: true,
    expectOutput: "below the 800 floor",
  },
  {
    name: "a KNOWN_EXCEPTIONS entry that matches nothing FAILS the run",
    // The live list holds exactly one entry, for the log-sanitiser fixture. This
    // tree omits that file, so the entry goes stale and the shrink discipline
    // must fire. If the list is ever emptied legitimately, this case stops being
    // able to fail — delete it then, rather than weakening it.
    files: {
      "package.json": `${JSON.stringify({ name: "fixture" }, null, 2)}\n`,
      "packages/backend/src/db/postgres.ts": "export const dialect = 'postgres';\n",
    },
    expectFailure: true,
    expectOutput: "no longer matches anything",
  },
];

let failed = 0;
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
  console.error(`\n${failed} of ${cases.length} guard cases failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} guard cases passed.`);
