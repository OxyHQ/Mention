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
 * A tree holding the given English entries, an `es` catalog covering the same
 * keys, and one source file calling `t()` for each key so nothing is reported
 * as orphaned. `translations` overrides individual `es` values and may add
 * keys English does not have.
 *
 * The default `es` value is the English text with a marker prefix — not a copy
 * of it — because a catalog byte-identical to English is itself a failure, and
 * every case here would otherwise trip that rule instead of the one it tests.
 */
function tree(english, translations = {}) {
  const keys = Object.keys(english);
  const spanish = { ...translations };
  for (const [key, value] of Object.entries(english)) {
    if (!(key in spanish)) spanish[key] = `es ${value}`;
  }
  return {
    "scripts/i18n-known-gaps.json": catalog({
      keysMissingFromSourceCatalog: [],
      orphanedTranslations: {},
    }),
    "packages/frontend/locales/en.json": catalog(english),
    "packages/frontend/locales/es.json": catalog(spanish),
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

  // ------------------------------------------------------- CLDR plurals ---
  // English has two plural categories; Russian has four and Arabic six. The
  // extra forms appear in no English catalog and at no call site, so the orphan
  // rule has to know them from an invented key or a correct translation is the
  // expensive path to a red build.
  {
    name: "a plural category English lacks is accepted in a translation",
    files: tree(
      { "lanes.postCount_one": "{{count}} post", "lanes.postCount_other": "{{count}} posts" },
      { "lanes.postCount_few": "{{count}} поста", "lanes.postCount_many": "{{count}} постов" },
    ),
    expectFailure: false,
  },
  {
    name: "a plural suffix on a key English does not define is still an orphan",
    files: tree(
      { "lanes.postCount_one": "{{count}} post", "lanes.postCount_other": "{{count}} posts" },
      { "lanes.inventedCount_few": "{{count}} поста" },
    ),
    expectFailure: true,
    expectOutput: "has no en source and no call site",
  },

  {
    name: "a value that is its own dotted key path is rejected",
    files: tree({ "notification.delete_error": "notification.delete_error" }),
    expectFailure: true,
    expectOutput: "is set to its own key path",
  },
  {
    name: "an English prose key equal to its value still passes",
    files: tree({ "Trending now": "Trending now" }),
    expectFailure: false,
  },

  {
    name: "a JavaScript template literal in a value is rejected",
    files: tree({ "profile.blockUser": "Block @${displayUsername}" }),
    expectFailure: true,
    expectOutput: "JavaScript template-literal syntax",
  },
  {
    name: "the i18next interpolation form of the same string passes",
    files: tree({ "profile.blockUser": "Block @{{username}}" }),
    expectFailure: false,
  },

  {
    name: "a literal JavaScript escape sequence in a value is rejected",
    files: tree({ "labelers.searchPlaceholder": "Search labelers\\u2026" }),
    expectFailure: true,
    expectOutput: "JavaScript escape sequence",
  },
  {
    name: "the character the escape stands for passes",
    files: tree({ "labelers.searchPlaceholder": "Search labelers\u2026" }),
    expectFailure: false,
  },
  {
    name: "a real newline in a value passes",
    files: tree({ "compose.hint": "First line\nsecond line" }),
    expectFailure: false,
  },

  // ------------------------------------------- English wearing a language ---
  // The rule that every key must exist in every catalog is satisfied just as
  // well by copying en.json, and twelve catalogs shipped that way.
  {
    name: "a catalog byte-identical to English is rejected",
    files: (() => {
      const english = Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`screen.label${index}`, `Label ${index} text`]),
      );
      return tree(english, english);
    })(),
    expectFailure: true,
    expectOutput: "is a copy of the English catalog",
  },
  {
    name: "declared translation debt lets an unfinished catalog through",
    files: (() => {
      const english = Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`screen.label${index}`, `Label ${index} text`]),
      );
      const files = tree(english, english);
      files["scripts/i18n-known-gaps.json"] = `${JSON.stringify(
        { keysMissingFromSourceCatalog: [], orphanedTranslations: {}, untranslatedByLanguage: { es: 20 } },
        null,
        2,
      )}\n`;
      return files;
    })(),
    expectFailure: false,
  },
  {
    name: "declared debt smaller than the reality is rejected",
    files: (() => {
      const english = Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`screen.label${index}`, `Label ${index} text`]),
      );
      const files = tree(english, english);
      files["scripts/i18n-known-gaps.json"] = `${JSON.stringify(
        { keysMissingFromSourceCatalog: [], orphanedTranslations: {}, untranslatedByLanguage: { es: 5 } },
        null,
        2,
      )}\n`;
      return files;
    })(),
    expectFailure: true,
    expectOutput: "more than the 5 declared",
  },
  {
    name: "declared debt a finished translation no longer needs is rejected",
    files: (() => {
      const english = Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`screen.label${index}`, `Label ${index} text`]),
      );
      const files = tree(english);
      files["scripts/i18n-known-gaps.json"] = `${JSON.stringify(
        { keysMissingFromSourceCatalog: [], orphanedTranslations: {}, untranslatedByLanguage: { es: 20 } },
        null,
        2,
      )}\n`;
      return files;
    })(),
    expectFailure: true,
    expectOutput: "is no longer needed",
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
