// @ts-check
/**
 * Codegen for the hashtag character-class ranges (via regexpu-core).
 *
 * WHY THIS EXISTS
 * ---------------
 * A hashtag is defined in terms of Unicode general categories — a letter
 * (`\p{L}`) followed by letters, numbers (`\p{N}`), combining marks (`\p{M}`)
 * and `_`. Those property escapes are perfect on V8 (Node, web) but throw
 * `SyntaxError: Invalid RegExp: Invalid property name` at RUNTIME on React
 * Native's Hermes engine, which ships with `HERMES_ENABLE_UNICODE_REGEXP_-
 * PROPERTY_ESCAPES` OFF. A single such literal evaluated at module load crashes
 * the whole app at boot, and neither `hermesc` nor any web/V8 run reproduces it.
 *
 * `@mention/shared-types` is the ONE module the hashtag definition can live in
 * so the frontend linkifier, the backend extractor and the federation linkifier
 * cannot drift apart — but it is built with `tsc`, which does not rewrite regex
 * literals, so whatever is written here ships verbatim to every consumer,
 * INCLUDING the Hermes bundle. (The Expo app's Babel pipeline does lower `\p{…}`
 * for native targets, but that is a property of the app's build config, not of
 * this package; a shared module must be safe on its own terms.)
 *
 * The fix keeps the SOURCE readable and semantic and transpiles ONLY the
 * property-escape atoms to explicit code-point RANGES with `regexpu-core` — the
 * exact library Babel's `@babel/plugin-transform-unicode-property-regex` uses to
 * lower property escapes for Hermes targets. We pass `unicodePropertyEscapes:
 * 'transform'` and KEEP the `u` flag (no `unicodeFlag` transform), so only the
 * `\p{…}` atoms are rewritten. Output is the exact same match set as the
 * property-escape original → identical behavior on V8 and Hermes, zero runtime
 * cost, zero runtime dependency, and zero property escapes in the shipped code.
 *
 * This mirrors `@oxyhq/core`'s `scripts/generateDisplayNamePolicyRanges.mjs`,
 * which solves the same problem for the display-name policy.
 *
 * regexpu-core bundles its own pinned Unicode tables, so the emitted ranges are
 * deterministic per regexpu-core version (NOT tied to the running Node/V8
 * Unicode version). The generated file is committed; the build does NOT run this
 * script.
 *
 * REGENERATE with:
 *   cd packages/shared-types && bun run generate:hashtag-ranges
 * Only re-run when the category set or the regexpu-core version bumps.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import rewritePattern from 'regexpu-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'src', 'hashtagRanges.generated.ts');

/* ------------------------------------------------------------------ *
 * READABLE SOURCE — the human-authored definition of each category.  *
 * ------------------------------------------------------------------ */

/**
 * Letters of any script (General_Category L). The FIRST character of a hashtag,
 * and also legal in the continuation.
 */
const LETTERS = '\\p{L}';

/**
 * Numbers of any script (General_Category N). Continuation only — a hashtag may
 * not START with one, so `#2026` stays plain text.
 */
const NUMBERS = '\\p{N}';

/**
 * Combining marks (General_Category M). Required for the many scripts where a
 * written letter is not one code point: Devanagari (`ि`, virama), Arabic
 * harakat, Thai vowel signs, decomposed Vietnamese. Without these a tag in those
 * scripts is cut apart mid-grapheme. Continuation only — a mark by definition
 * attaches to a preceding base character.
 */
const MARKS = '\\p{M}';

/* ------------------------------------------------------------------ *
 * Transpile with regexpu-core (property escapes only; keep `u`).     *
 * ------------------------------------------------------------------ */

const REGEXPU_OPTS = { unicodePropertyEscapes: 'transform' };

/**
 * Transpile a character-class BODY of property escapes into an equivalent body
 * of explicit ranges, via regexpu-core, keeping `u`-mode. We wrap the body in a
 * positive class, transpile, and strip the outer `[]`. The result contains only
 * `\x…`/`\u…`/`\u{…}` escapes and range hyphens — zero property escapes — and is
 * interpolated straight into the composed classes in `hashtags.ts`.
 *
 * @param {string} body character-class body containing property escapes
 * @returns {string}
 */
function transpileClassBody(body) {
  const out = rewritePattern(`[${body}]`, 'u', REGEXPU_OPTS);
  if (!out.startsWith('[') || !out.endsWith(']')) {
    throw new Error(
      `regexpu-core did not return a single class for [${body}]: ${out.slice(0, 48)}`,
    );
  }
  const inner = out.slice(1, -1);
  if (/\\[pP]\{/.test(inner)) {
    throw new Error('transpiled class body still contains a Unicode property escape');
  }
  // Must recompile as a `u`-mode class (the shape production uses).
  new RegExp(`[${inner}]`, 'u');
  return inner;
}

const letters = transpileClassBody(LETTERS);
const numbers = transpileClassBody(NUMBERS);
const marks = transpileClassBody(MARKS);

/**
 * Emit a class-body string as a single-quoted TS string literal, escaping
 * backslashes (the bodies are ASCII escape sequences like `\xAA`, `\u{1D400}`)
 * so the literal reproduces them verbatim.
 *
 * @param {string} body
 */
function toStringLiteral(body) {
  return `'${body.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const header = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Explicit Unicode code-point ranges for the hashtag character classes,
 * transpiled from the readable General_Category escapes in
 * \`scripts/generateHashtagRanges.mjs\` with regexpu-core (the same transform
 * Babel uses to lower Unicode property escapes for Hermes targets).
 *
 * Each export is a character-class BODY (no surrounding \`[]\`) using only
 * \`\\x…\`/\`\\u…\`/\`\\u{…}\` code-point escapes — and ZERO Unicode property
 * escapes — so the regexes composed from them in \`hashtags.ts\` run identically
 * on V8 (Node, web) and Hermes (React Native), whose engine has Unicode property
 * escapes compiled OUT. A bare property escape at module load throws "Invalid
 * RegExp: Invalid property name" and crashes the Expo app at boot; this package
 * is built with \`tsc\`, which would ship one verbatim. The transpiled ranges are
 * the exact same match set as the property escapes.
 *
 * Every class body uses \`u\`-mode syntax (astral \`\\u{…}\` escapes), so a regex
 * built from these MUST carry the \`u\` flag.
 *
 * Classes captured (regexpu-core, u-mode):
 *   - UNICODE_LETTER_RANGES: General_Category L (letters of any script).
 *   - UNICODE_NUMBER_RANGES: General_Category N (numbers of any script).
 *   - UNICODE_MARK_RANGES:   General_Category M (combining marks).
 *
 * REGENERATE: cd packages/shared-types && bun run generate:hashtag-ranges
 */
`;

const contents = `${header}
export const UNICODE_LETTER_RANGES =
  ${toStringLiteral(letters)};

export const UNICODE_NUMBER_RANGES =
  ${toStringLiteral(numbers)};

export const UNICODE_MARK_RANGES =
  ${toStringLiteral(marks)};
`;

// Defensive: the whole point is a property-escape-free output.
if (/\\[pP]\{/.test(contents)) {
  throw new Error('Generated file still contains a Unicode property escape');
}

writeFileSync(OUT_PATH, contents);

console.log(`Wrote ${OUT_PATH}`);
console.log(
  `  letters: ${letters.length} chars, numbers: ${numbers.length}, ` +
    `marks: ${marks.length} (regexpu-core)`,
);
