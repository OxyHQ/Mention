/**
 * THE definition of what a hashtag is, shared by every matcher in the product.
 *
 * Four places used to answer "which characters are a hashtag?" independently —
 * the frontend linkifier, the backend extractor, the backend spam-block scanner
 * and the outbound-federation HTML linkifier — and they disagreed. Three
 * accepted only `[A-Za-z0-9_]`, so `#BundesländerTurnier` was linked as
 * `#Bundesl` (the match died at the `ä`), while the backend's SANITIZER already
 * kept any Unicode letter or number, so the same tag was STORED whole. Detection
 * and storage contradicting each other is the bug; a single shared definition is
 * the fix.
 *
 * THE RULE, in Unicode General_Category terms
 *   first character   a letter of any script                          (L)
 *   then              letters, numbers, combining marks, or `_`       (L, N, M)
 *
 * A hashtag must OPEN with a letter, so `#2026` and `#_x` stay plain text — the
 * `#[A-Za-z]` rule that was there before, widened from ASCII to every script
 * rather than dropped. Combining marks are legal only in the continuation
 * because a mark attaches to a preceding base character; that is what keeps
 * Devanagari, Arabic, Thai and decomposed Vietnamese tags from being cut apart
 * mid-grapheme. Emoji are excluded: they are symbols (category S), not letters.
 *
 * HERMES SAFETY — why these are strings of code-point ranges rather than Unicode
 * property escapes. React Native's Hermes has property escapes compiled OUT and
 * throws `SyntaxError: Invalid RegExp: Invalid property name` at RUNTIME on
 * every one of them; a single such atom in a module-load-time literal crashes
 * the app at boot, and neither `hermesc` nor any V8 run reproduces it. This
 * package is built with `tsc`, which ships regex sources verbatim to the Metro
 * bundle, so the property escapes are lowered to explicit ranges at BUILD time
 * instead — see `hashtagRanges.generated.ts` and
 * `scripts/generateHashtagRanges.mjs`.
 *
 * That is also why neither this file nor the generated one may contain the
 * property-escape NOTATION at all, even inside a comment: the regression gate in
 * `__tests__/hashtags.test.ts` is a flat text scan, and a gate that needs a
 * parser to tell code from prose is a gate that eventually gets an exception
 * carved into it.
 *
 * These are regex SOURCE strings rather than `RegExp` instances on purpose: a
 * shared `/g` regex carries mutable `lastIndex`, so two callers using the same
 * instance would corrupt each other's scans. Each site compiles its own.
 *
 * Every export below uses `u`-mode syntax (astral `\u{…}` escapes) — a regex
 * built from any of them MUST carry the `u` flag.
 */

import {
  UNICODE_LETTER_RANGES,
  UNICODE_MARK_RANGES,
  UNICODE_NUMBER_RANGES,
} from './hashtagRanges.generated';

/**
 * Character-class BODY (no `[]`) for the legal FIRST character of a hashtag: a
 * letter of any script.
 */
export const HASHTAG_START_CLASS = UNICODE_LETTER_RANGES;

/**
 * Character-class BODY (no `[]`) for every legal character AFTER the first:
 * letters, numbers, combining marks and `_`.
 *
 * This doubles as the "inside a word" class: a `#` immediately preceded by one
 * of these opens no hashtag (see {@link HASHTAG_BOUNDARY_SOURCE}), and anything
 * outside it is stripped from a stored tag (see
 * {@link HASHTAG_DISALLOWED_SOURCE}).
 */
export const HASHTAG_CONTINUE_CLASS = `${UNICODE_LETTER_RANGES}${UNICODE_NUMBER_RANGES}${UNICODE_MARK_RANGES}_`;

/** The tag text WITHOUT the leading `#`, ungrouped — wrap it to capture. */
export const HASHTAG_BODY_SOURCE = `[${HASHTAG_START_CLASS}][${HASHTAG_CONTINUE_CLASS}]*`;

/** A complete `#tag` token, ungrouped. */
export const HASHTAG_TOKEN_SOURCE = `#${HASHTAG_BODY_SOURCE}`;

/**
 * One character that must NOT precede the `#` for it to open a hashtag, so a
 * `#` landing inside a word is not a tag. ASCII-only boundaries were incoherent
 * once tags carry non-ASCII letters: with `[^A-Za-z0-9_]`, the `#Bar` in
 * `#Café#Bar` matched (preceded by `é`) while the one in `#Cafe#Bar` did not.
 */
export const HASHTAG_BOUNDARY_SOURCE = `[^${HASHTAG_CONTINUE_CLASS}]`;

/** A run of characters that may not appear in a stored hashtag. */
export const HASHTAG_DISALLOWED_SOURCE = `[^${HASHTAG_CONTINUE_CLASS}]+`;

/**
 * Leading combining marks — an ORPHANED mark, one with no base character to
 * attach to. Detection can never produce one (a hashtag opens with a letter),
 * but a user-supplied or federated tag array can, and admitting marks to the
 * stored form is what makes it reachable. Stripped during normalization so a
 * tag can never be a bare floating accent.
 */
export const HASHTAG_LEADING_MARKS_SOURCE = `^[${UNICODE_MARK_RANGES}]+`;
