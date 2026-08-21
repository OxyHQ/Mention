#!/usr/bin/env bun

/**
 * Mutation-tests the "value is only its own key" rule in `validate-i18n.mjs`.
 *
 * The rule exists because the check it sits beside — every key must exist in
 * every catalog — is cheapest to satisfy by machine-filling the value from the
 * key, and 337 entries entered all fifteen catalogs that way while every gate
 * stayed green. A rule written to catch that has exactly one way to fail
 * usefully and two ways to fail quietly: never firing, or firing on the
 * Title Case that legitimate English labels already use. Both are covered here.
 *
 * Fixtures are whole repository trees and the REAL validator runs against them,
 * so the catalog reader, the key extractor and the rule all execute.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = resolve(repositoryRoot, "scripts/validate-i18n.mjs");

/** Canonical catalog formatting, which the validator requires of every file. */
function catalog(entries) {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

/**
 * A tree holding the given English entries, an `es` copy of them, and one
 * source file calling `t()` for each key so nothing is reported as orphaned.
 * `translations` overrides individual `es` values.
 */
function tree(english, translations = {}) {
  const keys = Object.keys(english);
  return {
    "scripts/i18n-known-gaps.json": catalog({
      keysMissingFromSourceCatalog: [],
      orphanedTranslations: {},
    }),
    "packages/frontend/locales/en.json": catalog(english),
    "packages/frontend/locales/es.json": catalog({ ...english, ...translations }),
    "packages/frontend/app/screen.tsx": `${keys
      .map((key) => `export const k${keys.indexOf(key)} = t(${JSON.stringify(key.replace(/_(?:zero|one|two|few|many|other)$/, ""))}, { count: 1 });`)
      .join("\n")}\n`,
  };
}

async function runAgainst(files, { realFloors = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "i18n-validator-"));
  try {
    for (const [path, contents] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, contents);
    }
    const environment = { ...process.env, I18N_VALIDATOR_ROOT: root };
    if (!realFloors) environment.I18N_VALIDATOR_FIXTURE_FLOORS = "1";
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

const cases = [
  {
    name: "real copy passes",
    files: tree({ "settings.account.signedOutTitle": "Sign in to Mention" }),
    expectFailure: false,
  },

  // ------------------------------------------------ the shape #738 produced ---
  {
    name: "an English value that is its key spelled out is rejected",
    files: tree({ "settings.account.signedOutTitle": "Signed Out Title" }),
    expectFailure: true,
    expectOutput: 'is the key spelled out rather than copy',
  },
  {
    name: "the same value in a translation is rejected, naming that language",
    files: tree(
      { "settings.account.signedOutTitle": "Sign in to Mention" },
      { "settings.account.signedOutTitle": "Signed Out Title" },
    ),
    expectFailure: true,
    expectOutput: "write the real es translation",
  },
  {
    name: "a snake_case key spelled out is rejected",
    files: tree({ "compose.clear_all_description": "Clear All Description" }),
    expectFailure: true,
    expectOutput: 'is the key spelled out rather than copy',
  },
  {
    name: "a plural form is rejected on the key with its CLDR suffix stripped",
    files: tree({
      "compose.poll.optionCount_one": "Option Count",
      "compose.poll.optionCount_other": "{{count}} options",
    }),
    expectFailure: true,
    expectOutput: "compose.poll.optionCount_one",
  },

  // ------------------------------ the Title Case that must NOT be rejected ---
  // Sixty entries in the live catalog look like this. A rule that fired on them
  // would be switched off by whoever hit it first, so each shape gets a case.
  {
    name: "a legitimate Title Case label passes",
    files: tree({ "profile.editProfile": "Edit Profile" }),
    expectFailure: false,
  },
  {
    name: "a Title Case label whose last word is an acronym passes",
    files: tree({ "settings.aboutMention.oxySDK": "Oxy SDK" }),
    expectFailure: false,
  },
  {
    name: "a single-word key equal to its value passes",
    files: tree({ "accounts.accountCategory.art": "Art" }),
    expectFailure: false,
  },
  {
    name: "sentence case under a slot-word key passes",
    files: tree({ "settings.account.signedOutTitle": "Signed out title" }),
    expectFailure: false,
  },

  // ------------------------------------------------------- vacuity floors ---
  {
    name: "the real floors reject a tree this small",
    files: tree({ "settings.account.signedOutTitle": "Sign in to Mention" }),
    realFloors: true,
    expectFailure: true,
    expectOutput: "below the",
  },
];

let failed = 0;
for (const testCase of cases) {
  const { exitCode, output } = await runAgainst(testCase.files, { realFloors: testCase.realFloors });
  const didFail = exitCode !== 0;
  const problems = [];
  if (didFail !== testCase.expectFailure) {
    problems.push(`expected the validator to ${testCase.expectFailure ? "fail" : "pass"}, it ${didFail ? "failed" : "passed"}`);
  }
  if (testCase.expectOutput && !output.includes(testCase.expectOutput)) {
    problems.push(`expected the output to mention "${testCase.expectOutput}"`);
  }
  if (problems.length > 0) {
    failed += 1;
    console.error(`FAIL ${testCase.name}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(output.split("\n").map((line) => `  | ${line}`).join("\n"));
  } else {
    console.log(`ok   ${testCase.name}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} cases failed.`);
  process.exit(1);
}
console.log(`\n${cases.length} cases passed.`);
