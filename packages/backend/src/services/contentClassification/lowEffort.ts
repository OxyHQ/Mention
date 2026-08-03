/**
 * Deterministic LOW-EFFORT content detection for the Stage-A baseline classifier.
 *
 * Targets the "no real writing" junk shapes that slip past the plain
 * spam/quality heuristics because they technically contain "letters":
 *   - custom-emoji SHORTCODE-only posts (`:oyaki::oyaki:` — Misskey/Mastodon
 *     render these as inline images; the raw text is just colon-delimited tokens
 *     whose letters are NOT prose), and
 *   - Unicode EMOJI-only posts (`🔥🔥🚀`).
 *
 * URLs and hashtags are located with the shared scanner from
 * `@mention/shared-types/textEntities`, so what this discounts as decoration is
 * the same thing the renderer linkifies and the extractor stores.
 *
 * It measures the REAL letter count that survives after stripping every piece of
 * non-prose scaffolding — custom-emoji shortcodes, URLs, @mentions, #hashtags,
 * and `\p{Extended_Pictographic}` emoji — then classifies the remainder. Pure,
 * synchronous, and allocation-light, so it is safe to run inline on every post
 * (native + federated) at ingest.
 */

import {
  countTextEntities,
  scanTextEntities,
  stripTextEntities,
} from '@mention/shared-types/textEntities';

/** Custom-emoji shortcode token, e.g. `:oyaki:`, `:blob_cat:`, `:+1:`. */
const SHORTCODE_PATTERN = /:[a-z0-9_+-]+:/gi;
/**
 * The scaffolding kinds located by the shared scanner — the SAME definitions the
 * renderer linkifies and the extractor stores, so what this discounts as
 * decoration is exactly what a reader sees as a link.
 *
 * `bareWww: false` keeps this measuring what it has always measured: a
 * scheme-bearing link. A bare `www.…` run stays prose here.
 */
const SCAFFOLD_KINDS = ['url', 'bareHandle', 'hashtag'] as const;
/** Any Unicode emoji / pictographic glyph. */
const EMOJI_PATTERN = /\p{Extended_Pictographic}/gu;
/** A single "content" character — a letter or a digit (real, non-decorative text). */
const CONTENT_CHAR_PATTERN = /[\p{L}\p{N}]/gu;
/** A single letter (the unit of "real text" the length is measured in). */
const LETTER_PATTERN = /\p{L}/gu;

/**
 * The low-effort thresholds this detector reads — a structural subset of
 * `SPAM_QUALITY_CONFIG.lowEffort`, so the caller passes that block directly.
 */
export interface LowEffortConfig {
  /**
   * Real-letter count (after stripping all scaffolding) BELOW which the post
   * carries no meaningful prose.
   */
  minRealTextLength: number;
}

/** Result of {@link detectLowEffort}. */
export interface LowEffortResult {
  /** Count of `\p{L}` letters left after stripping shortcodes/URLs/mentions/hashtags/emoji. */
  realTextLength: number;
  /** `realTextLength < cfg.minRealTextLength` — the post has no meaningful prose. */
  isNoRealText: boolean;
  /** The post body is ONLY custom-emoji shortcodes (plus emoji/punctuation/space). */
  shortcodeOnly: boolean;
  /** The post body is ONLY Unicode emoji (plus punctuation/space). */
  emojiOnly: boolean;
  /**
   * Count of Unicode `\p{Extended_Pictographic}` emoji glyphs in the raw text.
   * Exposed alongside {@link realTextLength} so a caller can compute an emoji
   * RATIO (`emojiCount / (emojiCount + realTextLength)`) without re-parsing the
   * text — the `noLowEffort` composable filter's optional emoji-heavy check.
   */
  emojiCount: number;
}

/**
 * Detect low-effort "no real text" shapes on a post's raw text. Pure: no DB, no
 * network, no mutation.
 *
 * `realTextLength` counts the letters that remain after every scaffolding token
 * is removed. `shortcodeOnly` / `emojiOnly` additionally require that NOTHING but
 * decorative content (emoji/punctuation/whitespace) and the relevant token type
 * survived — i.e. the body is made up EXCLUSIVELY of shortcodes (resp. emoji),
 * with no URLs, mentions, hashtags, letters, or digits.
 */
export function detectLowEffort(rawText: string, cfg: LowEffortConfig): LowEffortResult {
  const raw = rawText ?? '';

  // String#match with a global flag resets lastIndex, so these counts are safe to
  // read repeatedly (unlike a stateful RegExp#test on a /g/ pattern).
  const shortcodeCount = (raw.match(SHORTCODE_PATTERN) ?? []).length;
  const emojiCount = (raw.match(EMOJI_PATTERN) ?? []).length;
  // Shortcodes come out first (they can contain characters the scanner would
  // otherwise read), and the ONE scan of what remains supplies both the tallies
  // and the spans to strip — so a URL and the `#fragment` inside it can never be
  // counted as two separate pieces of scaffolding.
  const withoutShortcodes = raw.replace(SHORTCODE_PATTERN, ' ');
  const scanOptions = { kinds: SCAFFOLD_KINDS, bareWww: false } as const;
  const scaffold = scanTextEntities(withoutShortcodes, scanOptions);
  const urlCount = countTextEntities(scaffold, 'url');
  const hashtagCount = countTextEntities(scaffold, 'hashtag');
  const mentionCount = countTextEntities(scaffold, 'bareHandle');

  const stripped = stripTextEntities(withoutShortcodes, scanOptions)
    .replace(EMOJI_PATTERN, ' ');

  const realTextLength = (stripped.match(LETTER_PATTERN) ?? []).length;
  const contentCharCount = (stripped.match(CONTENT_CHAR_PATTERN) ?? []).length;

  const isNoRealText = realTextLength < cfg.minRealTextLength;

  // Nothing but emoji/punctuation/whitespace survived the strip AND no
  // URL/mention/hashtag scaffolding was present — so the body is decoration only.
  const decorativeOnly = contentCharCount === 0 && urlCount === 0 && mentionCount === 0 && hashtagCount === 0;
  const shortcodeOnly = decorativeOnly && shortcodeCount > 0;
  const emojiOnly = decorativeOnly && shortcodeCount === 0 && emojiCount > 0;

  return { realTextLength, isNoRealText, shortcodeOnly, emojiOnly, emojiCount };
}
