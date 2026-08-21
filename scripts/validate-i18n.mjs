#!/usr/bin/env bun

/**
 * Validates the frontend translation catalogs, and every statically written
 * `t()` key in the app against them.
 *
 * Ported in intent from bluesky-social/social-app dcc8b3514 ("Add checks for
 * invalid syntax post-i18n builds", MIT (c) 2023-2026 Bluesky Social PBC), which
 * found that its translation compiler printed `invalid syntax` for a
 * translator-broken message and still exited 0, so a broken catalog shipped.
 * Mention compiles nothing — `lib/i18n.ts` hands these JSON files straight to
 * i18next — so there is no build output to grep and the equivalent check has to
 * read the catalogs itself.
 *
 * Everything below is invisible at runtime: i18next never throws for a bad
 * catalog. It renders the key, or the placeholder, verbatim.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot =
  process.env.I18N_VALIDATOR_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRoot = resolve(repositoryRoot, "packages/frontend");
const localesDirectory = resolve(frontendRoot, "locales");
const baselinePath = resolve(repositoryRoot, "scripts/i18n-known-gaps.json");

/** `en` is both `DEFAULT_LANGUAGE` and i18next's `fallbackLng` (`lib/i18n.ts`). */
const SOURCE_LANGUAGE = "en";

/**
 * Directories whose code ships to users. Tests are excluded because they assert
 * on keys that deliberately do not exist.
 */
const SOURCE_DIRECTORIES = [
  "app",
  "components",
  "context",
  "hooks",
  "lib",
  "modules",
  "services",
  "stores",
  "utils",
];

const SOURCE_EXTENSIONS = /\.(?:tsx?|jsx?)$/;
const EXCLUDED_PATH =
  /(?:^|\/)(?:node_modules|dist|__tests__|__mocks__)(?:\/|$)|\.(?:test|spec)\.[jt]sx?$/;

/**
 * English's CLDR plural categories. i18next appends these to the key when the
 * call passes `count`, and only then, so a key with plural forms and no base
 * form resolves for `t(key, {count})` and not for `t(key)`.
 */
const PLURAL_SUFFIXES = ["_one", "_other"];

/**
 * Vacuity floors. A directory walk that quietly stops finding files, or an
 * extractor broken by a syntax change, would otherwise report a clean run, so
 * the check has to be able to tell "nothing is wrong" from "nothing was
 * inspected". Set well below the current counts (518 files, 1276 keys, 1394
 * source entries) so ordinary deletions never trip them.
 *
 * `I18N_VALIDATOR_FIXTURE_FLOORS=1` drops them for the mutation test, whose
 * fixture trees hold a handful of files on purpose. The real floors still run
 * in that test's own case for them.
 */
const fixtureFloors = process.env.I18N_VALIDATOR_FIXTURE_FLOORS === "1";
const MINIMUM_SCANNED_FILES = fixtureFloors ? 1 : 400;
const MINIMUM_EXTRACTED_KEYS = fixtureFloors ? 1 : 900;
const MINIMUM_CATALOG_ENTRIES = fixtureFloors ? 1 : 1000;

const failures = [];
const notes = [];

/**
 * i18next's own key resolution, so this check agrees with what users see rather
 * than with a simplified model of it: a flat key wins over a nested path, and a
 * dotted path resolves segment by segment while letting any segment contain
 * dots itself. Ported from i18next's `deepFind` (`dist/cjs/i18next.js`, MIT).
 */
function resolveKey(catalog, key) {
  if (!catalog) return undefined;
  if (Object.prototype.hasOwnProperty.call(catalog, key)) return catalog[key];

  const tokens = key.split(".");
  let current = catalog;
  for (let index = 0; index < tokens.length; ) {
    if (!current || typeof current !== "object") return undefined;
    let next;
    let nextPath = "";
    for (let end = index; end < tokens.length; ++end) {
      if (end !== index) nextPath += ".";
      nextPath += tokens[end];
      next = current[nextPath];
      if (next !== undefined) {
        if (typeof next === "string" && end < tokens.length - 1) continue;
        index += end - index + 1;
        break;
      }
    }
    current = next;
  }
  return current;
}

/**
 * A nested leaf whose full path is also spelled as a flat top-level key.
 *
 * These catalogs mix both spellings, and i18next's `deepFind` returns
 * `catalog[path]` before it walks anything, so the flat entry always wins and
 * the nested one is text no user can reach. Nine pairs existed when this check
 * was written, three of them with genuinely different wording — a reviewer had
 * approved copy that was already dead on arrival. `findDuplicateKeys` cannot
 * see this: both spellings are legal JSON in different objects.
 */
function findShadowedPaths(parsed) {
  const flatKeys = new Set(
    Object.entries(parsed)
      .filter(([, value]) => value === null || typeof value !== "object" || Array.isArray(value))
      .map(([key]) => key),
  );
  const shadowed = [];
  (function walk(node, prefix) {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) walk(value, path);
      else if (prefix && flatKeys.has(path)) shadowed.push(path);
    }
  })(parsed, "");
  return shadowed;
}

/** Every leaf entry of a catalog, as `dotted.path -> value`. */
function flattenCatalog(value, prefix, into) {
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      flattenCatalog(entry, path, into);
    } else {
      into.set(path, entry);
    }
  }
  return into;
}

/**
 * Duplicate keys inside one object: `JSON.parse` keeps the last and silently
 * drops the rest, so a merge can overwrite a translation with no trace. Sound
 * because every catalog is required (below) to be canonically pretty-printed,
 * which puts exactly one key on each line.
 */
function findDuplicateKeys(source) {
  const duplicates = [];
  const seenByDepth = new Map();
  let lineNumber = 0;
  for (const line of source.split("\n")) {
    lineNumber += 1;
    const match = /^(\s*)"((?:[^"\\]|\\.)*)"\s*:/.exec(line);
    if (!match) continue;
    const [, indent, rawKey] = match;
    const depth = indent.length;
    for (const knownDepth of [...seenByDepth.keys()]) {
      if (knownDepth > depth) seenByDepth.delete(knownDepth);
    }
    let seen = seenByDepth.get(depth);
    if (!seen) {
      seen = new Map();
      seenByDepth.set(depth, seen);
    }
    const key = JSON.parse(`"${rawKey}"`);
    if (seen.has(key)) {
      duplicates.push({ key, lineNumber, firstLineNumber: seen.get(key) });
    } else {
      seen.set(key, lineNumber);
    }
  }
  return duplicates;
}

/**
 * i18next interpolation is `{{name}}`, optionally `{{- name}}` (unescaped) or
 * `{{name, formatter}}`. Anything it cannot parse reaches the screen verbatim,
 * which is the translator-authored breakage this check exists for.
 */
function inspectPlaceholders(value) {
  const names = new Set();
  const problems = [];
  const wellFormed = /\{\{([^{}]*)\}\}/g;
  let match;
  while ((match = wellFormed.exec(value)) !== null) {
    const name = match[1].split(",")[0].replace(/^\s*-?\s*/, "").trim();
    if (name === "") {
      problems.push(`the empty placeholder \`${match[0]}\``);
      continue;
    }
    if (!/^[A-Za-z0-9_$.[\]]+$/.test(name)) {
      problems.push(`\`${match[0]}\`, whose name i18next cannot look up`);
      continue;
    }
    names.add(name);
  }

  const residue = value.replace(wellFormed, "");
  if (residue.includes("{{")) problems.push("an unclosed `{{`");
  if (residue.includes("}}")) problems.push("a `}}` with no opening `{{`");

  // `${name}` is JavaScript template-literal syntax, which i18next does not
  // interpolate — it prints the characters. Nine entries got here by having a
  // call site's `defaultValue: `Block @${displayUsername}`` harvested as source
  // text, and every user of every language read "Block @${displayUsername}".
  for (const match of value.matchAll(/\$\{([^{}]*)\}/g)) {
    problems.push(
      `\`${match[0]}\`, which is JavaScript template-literal syntax — i18next prints it verbatim; use {{${match[1].trim() || "name"}}} and pass the value at the call site`,
    );
  }

  return { names, problems };
}

/** Unescapes the body of a JavaScript string literal. */
function unescapeLiteral(raw) {
  return raw.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (_escape, body) => {
      switch (body[0]) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "b":
          return "\b";
        case "f":
          return "\f";
        case "v":
          return "\v";
        case "0":
          return "\0";
        case "u":
        case "x":
          return String.fromCodePoint(Number.parseInt(body.replace(/[ux{}]/g, ""), 16));
        default:
          return body;
      }
    },
  );
}

/**
 * The text of a call's remaining arguments, starting just past the comma that
 * follows the key. Brace- and quote-aware, so `defaultValue` is only ever read
 * out of this call and never out of the next one on the same line.
 */
function readRemainingArguments(source, start) {
  let depth = 1;
  let text = "";
  let cursor = start;
  while (cursor < source.length && depth > 0) {
    const character = source[cursor];
    if (character === "'" || character === '"' || character === "`") {
      text += character;
      cursor += 1;
      while (cursor < source.length) {
        const inner = source[cursor];
        text += inner;
        if (inner === "\\") {
          text += source[cursor + 1] ?? "";
          cursor += 2;
          continue;
        }
        cursor += 1;
        if (inner === character) break;
      }
      continue;
    }
    if (character === "(" || character === "{" || character === "[") depth += 1;
    else if (character === ")" || character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) break;
    }
    text += character;
    cursor += 1;
  }
  return text;
}

/**
 * Every `t('key')` / `i18n.t('key')` written as a literal, plus the static
 * prefixes of the keys this app assembles at runtime (`` t(`a.${b}`) ``).
 * Runtime keys cannot be checked statically, but their prefixes tell us which
 * catalog entries are reachable, which is what the orphan check below needs.
 */
function extractKeys(source) {
  const keys = [];
  const dynamicPrefixes = [];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "t" || source[index + 1] !== "(") continue;

    // `t(`, `.t(` only for `i18n.t(`; never the tail of another identifier.
    const before = source[index - 1];
    const isTranslateCall =
      before === undefined ||
      (!/[A-Za-z0-9_$]/.test(before) && before !== ".") ||
      source.slice(Math.max(0, index - 5), index) === "i18n.";
    if (!isTranslateCall) continue;

    let cursor = index + 2;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    const quote = source[cursor];
    if (quote !== "'" && quote !== '"' && quote !== "`") continue;

    let raw = "";
    cursor += 1;
    let terminated = false;
    for (; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (character === "\\") {
        raw += character + (source[cursor + 1] ?? "");
        cursor += 1;
        continue;
      }
      if (character === quote) {
        terminated = true;
        break;
      }
      if (character === "\n" && quote !== "`") break;
      raw += character;
    }
    if (!terminated) continue;

    if (quote === "`" && raw.includes("${")) {
      const prefix = raw.slice(0, raw.indexOf("${"));
      if (prefix) dynamicPrefixes.push(unescapeLiteral(prefix));
      continue;
    }

    cursor += 1;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;

    let hasDefault = false;
    let hasCount = false;
    if (source[cursor] === ",") {
      const argumentText = readRemainingArguments(source, cursor + 1).trim();
      // `t(key, 'English')` is i18next's positional default, `t(key, {defaultValue})`
      // the object form. Either way the English text lives at the call site and a
      // missing catalog entry never reaches the user.
      hasDefault = /^['"`]/.test(argumentText) || /\bdefaultValue\b/.test(argumentText);
      hasCount = /\bcount\b/.test(argumentText);
    }

    keys.push({ key: unescapeLiteral(raw), offset: index, hasDefault, hasCount });
  }

  return { keys, dynamicPrefixes };
}

async function collectSourceFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (EXCLUDED_PATH.test(relative(frontendRoot, path))) continue;
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(path)));
    } else if (SOURCE_EXTENSIONS.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

/** A key i18next would render verbatim as an identifier path rather than as prose. */
function isPathShaped(key) {
  return /^[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)+$/.test(key);
}

// ---------------------------------------------------------------------------
// 1. The catalogs parse, are canonically formatted, define each key once, and
//    every interpolation in them is one i18next can substitute.
// ---------------------------------------------------------------------------

const catalogNames = (await readdir(localesDirectory)).filter((name) => name.endsWith(".json")).sort();

const catalogs = new Map();
for (const name of catalogNames) {
  const path = resolve(localesDirectory, name);
  const source = await readFile(path, "utf8");

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    failures.push(`locales/${name}: is not valid JSON — ${error.message}`);
    continue;
  }

  if (source !== `${JSON.stringify(parsed, null, 2)}\n`) {
    failures.push(
      `locales/${name}: is not canonically formatted — rewrite it as JSON.stringify(catalog, null, 2) plus a trailing newline, so the duplicate-key check stays sound and merges stay reviewable`,
    );
  }

  for (const path of findShadowedPaths(parsed)) {
    failures.push(
      `locales/${name}: "${path}" is defined both as a flat key and inside a nested object — i18next serves the flat one, so the nested entry is unreachable; delete it`,
    );
  }

  for (const duplicate of findDuplicateKeys(source)) {
    failures.push(
      `locales/${name}:${duplicate.lineNumber}: duplicate key "${duplicate.key}", first defined on line ${duplicate.firstLineNumber} — JSON.parse silently keeps only the last`,
    );
  }

  const entries = flattenCatalog(parsed, "", new Map());
  for (const [key, value] of entries) {
    if (typeof value !== "string") {
      failures.push(
        `locales/${name}: key "${key}" is ${value === null ? "null" : typeof value}, not a string`,
      );
      continue;
    }
    for (const problem of inspectPlaceholders(value).problems) {
      failures.push(`locales/${name}: key "${key}" contains ${problem}`);
    }
  }

  catalogs.set(name.replace(/\.json$/, ""), { name, parsed, entries });
}

const sourceCatalog = catalogs.get(SOURCE_LANGUAGE);
if (!sourceCatalog) {
  failures.push(
    `locales/${SOURCE_LANGUAGE}.json: missing, but it is the source language and i18next's fallback`,
  );
} else if (sourceCatalog.entries.size < MINIMUM_CATALOG_ENTRIES) {
  failures.push(
    `locales/${SOURCE_LANGUAGE}.json: ${sourceCatalog.entries.size} entries is below the ${MINIMUM_CATALOG_ENTRIES} floor — the catalog reader is probably broken`,
  );
}

// ---------------------------------------------------------------------------
// 2. A translation never interpolates something its English source does not.
//    Callers pass values for the English placeholders, so an invented one is
//    rendered to that language's users as literal `{{text}}`.
// ---------------------------------------------------------------------------

if (sourceCatalog) {
  for (const [language, catalog] of catalogs) {
    if (language === SOURCE_LANGUAGE) continue;
    for (const [key, value] of catalog.entries) {
      if (typeof value !== "string") continue;
      const englishValue = sourceCatalog.entries.get(key);
      if (typeof englishValue !== "string") continue;
      const provided = inspectPlaceholders(englishValue).names;
      for (const name of inspectPlaceholders(value).names) {
        if (provided.has(name)) continue;
        failures.push(
          `locales/${catalog.name}: key "${key}" interpolates {{${name}}}, which its ${SOURCE_LANGUAGE} source does not — ${language} users see the placeholder verbatim`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Every key the app writes down has an English source entry.
//
//    Two different consequences, one rule. A path-shaped key with no entry is
//    rendered as `settings.some.key`. A prose key with no entry renders as
//    itself, which reads correctly in English but leaves the string invisible
//    to translators, so `es`/`it` can never render it. Calls that pass a
//    `defaultValue` are exempt: that default IS the English source, colocated
//    at the call site, and 356 call sites already use it that way.
// ---------------------------------------------------------------------------

const scannedFiles = [];
for (const directory of SOURCE_DIRECTORIES) {
  scannedFiles.push(...(await collectSourceFiles(resolve(frontendRoot, directory))));
}

if (scannedFiles.length < MINIMUM_SCANNED_FILES) {
  failures.push(
    `${scannedFiles.length} source files scanned is below the ${MINIMUM_SCANNED_FILES} floor — the directory walk is probably broken`,
  );
}

const callSites = [];
const usedKeys = new Set();
const dynamicPrefixes = new Set();
for (const path of scannedFiles) {
  const source = await readFile(path, "utf8");
  const { keys, dynamicPrefixes: prefixes } = extractKeys(source);
  for (const prefix of prefixes) dynamicPrefixes.add(prefix);
  for (const { key, offset, hasDefault, hasCount } of keys) {
    callSites.push({
      key,
      hasDefault,
      hasCount,
      location: `${relative(repositoryRoot, path)}:${source.slice(0, offset).split("\n").length}`,
    });
    usedKeys.add(key);
  }
}
callSites.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

if (usedKeys.size < MINIMUM_EXTRACTED_KEYS) {
  failures.push(
    `${usedKeys.size} translation keys extracted is below the ${MINIMUM_EXTRACTED_KEYS} floor — the key extractor is probably broken`,
  );
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));

/**
 * The share of byte-identical-to-English entries at which a catalog stops
 * being a translation. Loose on purpose: see the check that uses it.
 */
const ENGLISH_COPY_LIMIT = 0.9;
const declaredEnglishCopies = baseline.untranslatedByLanguage ?? {};
const allowedMissing = new Set(baseline.keysMissingFromSourceCatalog ?? []);
const stillMissing = new Set();

if (sourceCatalog) {
  const reported = new Set();
  for (const { key, location, hasCount } of callSites) {
    if (reported.has(key)) continue;

    const resolved = resolveKey(sourceCatalog.parsed, key);
    if (typeof resolved === "string") continue;
    if (resolved !== undefined) {
      reported.add(key);
      failures.push(
        `${location}: t("${key}") resolves to an object in locales/${SOURCE_LANGUAGE}.json, not a string`,
      );
      continue;
    }
    // With `count`, i18next looks the plural forms up instead of the base key.
    if (
      hasCount &&
      PLURAL_SUFFIXES.some((suffix) => typeof resolveKey(sourceCatalog.parsed, key + suffix) === "string")
    ) {
      continue;
    }
    // A default value only protects English users. Every user-facing call must
    // have a catalog entry so it can be translated for every supported locale.

    stillMissing.add(key);
    reported.add(key);
    if (allowedMissing.has(key)) continue;
    failures.push(
      isPathShaped(key)
        ? `${location}: t("${key}") has no entry in locales/${SOURCE_LANGUAGE}.json, so users see the raw key`
        : `${location}: t("${key}") has no entry in locales/${SOURCE_LANGUAGE}.json, so it renders in English for every language — add it to the catalog`,
    );
  }

  for (const key of allowedMissing) {
    if (stillMissing.has(key)) continue;
    failures.push(
      `scripts/i18n-known-gaps.json: "${key}" is listed under keysMissingFromSourceCatalog but now has an English entry — delete the line`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Key drift.
//
//    Missing FROM a translation fails the build: falling back would leave that
//    part of the app untranslated. Present in a translation with no
//    English source is an error when nothing in the app can reach the key —
//    that is a translation whose English source was renamed or deleted, and
//    no code path will ever render it again. A prose key that IS reached from
//    code is legitimate (English users get the key text, `es` users get the
//    translation), so reachability, not mere absence from `en`, is the test.
// ---------------------------------------------------------------------------

/**
 * A CLDR plural form of a key English does define.
 *
 * English has two plural categories and most of this app's languages have a
 * different number: Russian needs `few` and `many`, Arabic all six, Japanese
 * only `other`. i18next picks the category from the count at runtime, so a
 * correct Russian catalog carries `lanes.postCount_few`, which appears in no
 * English catalog and at no call site — the call site writes the base key.
 * Without this, the orphan rule below rejects every correctly pluralised
 * translation and the cheapest way to a green build is a wrong one.
 */
function isPluralFormOfEnglishKey(key) {
  const base = key.replace(/_(?:zero|one|two|few|many|other)$/, "");
  if (base === key) return false;
  return (
    sourceCatalog.entries.has(base) ||
    usedKeys.has(base) ||
    PLURAL_SUFFIXES.some((suffix) => sourceCatalog.entries.has(base + suffix))
  );
}

if (sourceCatalog) {
  const allowedOrphans = baseline.orphanedTranslations ?? {};

  for (const [language, catalog] of catalogs) {
    if (language === SOURCE_LANGUAGE) continue;

    const allowed = new Set(allowedOrphans[language] ?? []);
    const orphans = [...catalog.entries.keys()].filter(
      (key) =>
        !sourceCatalog.entries.has(key) &&
        !usedKeys.has(key) &&
        !isPluralFormOfEnglishKey(key) &&
        ![...dynamicPrefixes].some((prefix) => key.startsWith(prefix)),
    );
    const orphanSet = new Set(orphans);

    for (const key of orphans) {
      if (allowed.has(key)) continue;
      failures.push(
        `locales/${catalog.name}: key "${key}" has no ${SOURCE_LANGUAGE} source and no call site, so nothing can ever render it — delete it, or restore the ${SOURCE_LANGUAGE} key it was translated from`,
      );
    }
    for (const key of allowed) {
      if (orphanSet.has(key)) continue;
      failures.push(
        `scripts/i18n-known-gaps.json: "${key}" is listed under orphanedTranslations.${language} but is no longer orphaned — delete the line`,
      );
    }

    const untranslated = [...sourceCatalog.entries.keys()].filter((key) => !catalog.entries.has(key));
    for (const key of untranslated) {
      failures.push(
        `locales/${catalog.name}: key "${key}" is missing — every supported locale must cover the complete app`,
      );
    }
    // ----------------------------------------------------------------------
    // A catalog that is a copy of English, wearing a language's name.
    //
    // The rule above — every English key must exist in every catalog — is
    // satisfied just as well by copying `en.json` to `ja.json`, and that is
    // what happened: twelve catalogs shipped 2138/2138 English values while
    // every check here reported "0 untranslated". The count was never wrong;
    // nothing was measuring whether the entries were in the language.
    //
    // The threshold is loose on purpose. A finished translation leaves a few
    // dozen entries identical (brand names, "OK", "SDK"), never nine in ten.
    // And an honestly unfinished locale has somewhere to say so, so the
    // cheapest way to a green build is never to paste English in.
    // ----------------------------------------------------------------------
    const identical = [...catalog.entries].filter(
      ([key, value]) => sourceCatalog.entries.get(key) === value,
    ).length;
    const share = catalog.entries.size === 0 ? 0 : identical / catalog.entries.size;
    const declared = declaredEnglishCopies[language];

    if (declared === undefined && share >= ENGLISH_COPY_LIMIT) {
      failures.push(
        `locales/${catalog.name}: ${identical} of ${catalog.entries.size} entries (${Math.round(share * 100)}%) are byte-identical to ${SOURCE_LANGUAGE} — this is a copy of the English catalog, not a ${language} translation. If it is genuinely unfinished, declare it under untranslatedByLanguage in scripts/i18n-known-gaps.json rather than pasting English into it: i18next already falls back to ${SOURCE_LANGUAGE} for a key a catalog omits.`,
      );
    } else if (declared !== undefined && identical > declared) {
      failures.push(
        `locales/${catalog.name}: ${identical} entries are identical to ${SOURCE_LANGUAGE}, more than the ${declared} declared under untranslatedByLanguage in scripts/i18n-known-gaps.json — translate them, or raise the number deliberately`,
      );
    } else if (declared !== undefined && share < ENGLISH_COPY_LIMIT) {
      failures.push(
        `scripts/i18n-known-gaps.json: untranslatedByLanguage.${language} is no longer needed — only ${identical} of ${catalog.entries.size} entries are identical to ${SOURCE_LANGUAGE}; delete the line`,
      );
    }

    notes.push(
      `${catalog.name}: ${catalog.entries.size} entries, ${untranslated.length} untranslated (rendered in ${SOURCE_LANGUAGE}), ${orphans.length} orphaned, ${identical} identical to ${SOURCE_LANGUAGE} (${Math.round(share * 100)}%)`,
    );
  }
}

// ---------------------------------------------------------------------------
// 5. A value that is only its own key, spelled out.
//
//    Checks 3 and 4 together say every key must exist in every catalog. The
//    cheapest way to satisfy them is to machine-fill the gap from the key
//    itself — `signedOutTitle` becomes "Signed Out Title" — which is green here
//    and reads as broken copy on screen. That is not hypothetical: it is how
//    337 entries entered all fifteen catalogs at once, and neither this check
//    nor a reviewer scrolling a 5000-line diff caught it.
//
//    Title Case alone cannot be the test, because English UI labels really are
//    Title Case ("Edit Profile", "Coming Soon"): 60 legitimate entries match it
//    today, and a gate needing a 60-entry allowlist is a gate nobody maintains.
//    The signal that separates the two is the last word. Copy for a key ending
//    in `Title`, `Placeholder` or `Description` never IS the word "Title",
//    "Placeholder" or "Description" — those name the slot, not what fills it.
//
//    Bound, stated because a partial check reads like a total one: this catches
//    111 of those 337, the ones whose key ends in a slot word. It does not
//    catch `keepEditing` -> "Keep Editing", which no rule can tell from a real
//    label. It is precise, not complete — every entry it flags is wrong.
// ---------------------------------------------------------------------------

/**
 * Words that name the slot a string goes into rather than the string. A key
 * ending in one of these describes its own role, so copy equal to the spelled
 * out key is the generator's output and not a translation.
 */
const SLOT_WORDS = new Set([
  "a11y", "action", "body", "caption", "copy", "count", "cta", "desc",
  "description", "error", "failed", "footer", "header", "heading", "hint",
  "key", "label", "message", "name", "placeholder", "string", "subtitle",
  "success", "summary", "text", "title", "tooltip", "value",
]);

/** i18next appends a CLDR category to the key when the call passes `count`. */
const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/;

/** `signedOutTitle` -> ["signed", "Out", "Title"]; `hidden_words` -> ["hidden", "words"]. */
function splitIdentifier(segment) {
  return segment
    .replace(/[_-]+/g, " ")
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** The spelling-out a key-to-English generator produces. */
function spellOutKey(parts) {
  return parts.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

for (const [language, catalog] of catalogs) {
  for (const [key, value] of catalog.entries) {
    if (typeof value !== "string") continue;

    // The blunt version of the same mistake: the value IS the dotted key. Four
    // entries reached production this way and rendered `notification.delete_error`
    // on screen. Safe to test bluntly because these catalogs also use English
    // prose as keys ("Home": "Home"), and prose is not identifier-shaped.
    if (value === key && isPathShaped(key)) {
      failures.push(
        `locales/${catalog.name}: key "${key}" is set to its own key path, which is what users read — write the real ${language === SOURCE_LANGUAGE ? "English text" : `${language} translation`}, or take the English from the call site's defaultValue`,
      );
      continue;
    }

    const segment = key.split(".").at(-1).replace(PLURAL_SUFFIX, "");
    if (!/^[a-z][A-Za-z0-9_]*$/.test(segment)) continue;
    const parts = splitIdentifier(segment);
    if (parts.length < 2) continue;
    if (!SLOT_WORDS.has(parts.at(-1).toLowerCase())) continue;
    if (value !== spellOutKey(parts)) continue;
    failures.push(
      `locales/${catalog.name}: key "${key}" is set to "${value}", which is the key spelled out rather than copy — write the real ${language === SOURCE_LANGUAGE ? "English text" : `${language} translation`}, or take the English from the call site's defaultValue`,
    );
  }
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error("Translation validation failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error("");
  process.exit(1);
}

console.log(
  `Validated ${catalogs.size} translation catalogs (${sourceCatalog?.entries.size ?? 0} ${SOURCE_LANGUAGE} entries) and ${usedKeys.size} keys across ${scannedFiles.length} source files.`,
);
for (const note of notes) console.log(`  ${note}`);
