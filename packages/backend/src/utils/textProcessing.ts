/**
 * Shared text processing utilities for hashtag/mention extraction.
 * Consolidates duplicate regex patterns across controllers.
 */

import {
  HASHTAG_BODY_SOURCE,
  HASHTAG_DISALLOWED_SOURCE,
  HASHTAG_LEADING_MARKS_SOURCE,
  HASHTAG_TOKEN_SOURCE,
} from '@mention/shared-types/hashtags';
import { reconcileMentionIdsDetailed } from '@mention/shared-types/mentions';
import { logger } from './logger';

/**
 * Extraction pattern. Built from the shared definition in
 * `@mention/shared-types/hashtags` — the SAME source the frontend linkifier and
 * the outbound-federation linkifier compile — so what is detected here and what
 * is rendered as a link can no longer disagree. Requires the `u` flag (the class
 * bodies carry astral `\u{…}` escapes).
 */
const HASHTAG_REGEX = new RegExp(`#(${HASHTAG_BODY_SOURCE})`, 'gu');
export {
  extractMentionIds,
  normalizeMentionIds,
} from '@mention/shared-types/mentions';

/**
 * Server-side {@link reconcileMentionIds}: the same reconciliation and the same
 * `MAX_MENTIONS_PER_POST` ceiling, plus the log that keeps the ceiling from being a
 * silent drop.
 *
 * Every backend write boundary that persists a mention allowlist uses this rather
 * than the bare shared helper — the shared module is imported by the client too and
 * so cannot log, which is the whole reason it reports `total` instead.
 */
export function reconcileMentionIdsForPost(
  texts: Iterable<string | null | undefined>,
  authorizedIds: unknown,
): string[] {
  const { ids, total } = reconcileMentionIdsDetailed(texts, authorizedIds);
  if (total > ids.length) {
    logger.warn('[Mentions] truncated a post mention allowlist above the per-post ceiling', {
      mentioned: total,
      kept: ids.length,
    });
  }
  return ids;
}

/**
 * Extract hashtags from text content.
 * Returns lowercase, deduplicated array of tag names (without #).
 */
export function extractHashtags(text: string): string[] {
  if (!text) return [];
  const matches = Array.from(text.matchAll(HASHTAG_REGEX));
  return [...new Set(matches.map((m) => m[1].toLowerCase()))];
}

/**
 * Characters NOT allowed inside a stored hashtag — the complement of the shared
 * continuation class: unicode letters, unicode numbers, combining marks and
 * underscores. Everything else — spaces, tabs, newlines, punctuation, emoji,
 * ZWJ/separators — is stripped, so legitimate international tags federated
 * instances send (Japanese, accented Latin, Cyrillic, Devanagari, …) are
 * PRESERVED rather than mangled to ASCII.
 *
 * Combining marks are part of the allowed set because in Devanagari, Arabic,
 * Thai and decomposed Vietnamese a written letter is not one code point;
 * stripping them silently rewrote those tags into a different word.
 */
const HASHTAG_DISALLOWED_CHARS = new RegExp(HASHTAG_DISALLOWED_SOURCE, 'gu');

/**
 * Combining marks at the START of a would-be tag, i.e. marks with no base
 * character to attach to. Admitting marks to the stored form is what makes an
 * orphan reachable at all: extraction cannot produce one (a hashtag opens with a
 * letter), but a user-supplied or federated tag array can, and a tag that is a
 * bare floating accent is not a tag.
 */
const HASHTAG_LEADING_MARKS = new RegExp(HASHTAG_LEADING_MARKS_SOURCE, 'u');

/**
 * Canonical hashtag normalization.
 *
 * Strips a single leading `#`, trims surrounding whitespace, lowercases, then
 * removes every character that is not a unicode letter/number/underscore. This
 * collapses a multi-word value like `"the village and the hills"` into a single
 * Mastodon-style token (`thevillageandthehills`) and kills tabs, newlines,
 * punctuation, and emoji separators, while keeping legitimate unicode tags
 * intact (it is NOT restricted to ASCII).
 *
 * The result is the same form the case-insensitive read paths
 * (`getPostsByHashtag`, the MTN `HashtagFeed`, the `$toLower` trending
 * aggregations) expect. Returns `''` for empty/whitespace-only/all-invalid
 * input so callers can filter out non-tags (every caller does — see
 * `mergeHashtags` and `extractApHashtags`). This is the single source of truth
 * for the recipe that was previously duplicated across the native and federated
 * write paths.
 *
 * Order: strip leading `#` → trim → lowercase → remove disallowed chars → drop
 * orphaned leading combining marks.
 */
export function normalizeHashtag(raw: string): string {
  return raw
    .replace(/^#/, '')
    .trim()
    .toLowerCase()
    .replace(HASHTAG_DISALLOWED_CHARS, '')
    .replace(HASHTAG_LEADING_MARKS, '');
}

/**
 * Merge extracted hashtags with user-provided hashtags.
 *
 * Hashtags are stored canonically lowercased so that case-insensitive read
 * paths (`getPostsByHashtag`, the MTN `HashtagFeed`, the `$toLower` trending
 * aggregations) always match. Both the text-extracted tags and the
 * user-provided tags are run through `normalizeHashtag` before deduplication so
 * a mixed-case `userProvided` entry can never be stored verbatim. Empty entries
 * are dropped.
 *
 * Returns a deduplicated array of lowercase tag names.
 */
export function mergeHashtags(text: string, userProvided?: string[]): string[] {
  const extracted = extractHashtags(text)
    .map(normalizeHashtag)
    .filter((tag) => tag.length > 0);
  const normalizedUserProvided = (userProvided || [])
    .map(normalizeHashtag)
    .filter((tag) => tag.length > 0);
  return [...new Set([...normalizedUserProvided, ...extracted])];
}

/**
 * Minimum number of consecutive hashtags (separated only by whitespace) that
 * marks a block as "spammy" and triggers cleaning of the visible content.
 * Exactly three consecutive hashtags stay fully visible.
 */
export const SPAM_HASHTAG_BLOCK_THRESHOLD = 4;

/**
 * Matches a hashtag token. Compiled from the same shared source as
 * {@link HASHTAG_REGEX} so detection for cleaning and detection for the stored
 * `hashtags` field never diverge.
 */
const HASHTAG_TOKEN = HASHTAG_TOKEN_SOURCE;

/**
 * Matches a run of {@link SPAM_HASHTAG_BLOCK_THRESHOLD}+ consecutive hashtags
 * separated only by whitespace, extending to the end of input (a trailing
 * block) or up to the next non-whitespace, non-hashtag character.
 *
 * Capture group 1 is the leading whitespace before the block (used to decide
 * how much to trim when the block sits at the end of a sentence).
 */
const CONSECUTIVE_HASHTAG_BLOCK = new RegExp(
  `(\\s*)((?:${HASHTAG_TOKEN})(?:\\s+${HASHTAG_TOKEN}){${SPAM_HASHTAG_BLOCK_THRESHOLD - 1},})`,
  'gu',
);

/** The first hashtag token of a {@link CONSECUTIVE_HASHTAG_BLOCK} match. */
const FIRST_HASHTAG = new RegExp(HASHTAG_TOKEN, 'u');

/**
 * One line made of hashtags and nothing else: tokens separated only by
 * horizontal whitespace. Tested against a TRIMMED line, so indentation and a
 * trailing `\r` do not stop a line from qualifying.
 */
const HASHTAG_ONLY_LINE = new RegExp(`^${HASHTAG_TOKEN}(?:\\s+${HASHTAG_TOKEN})*$`, 'u');

/**
 * `text` without the hashtag-only lines at its end, and without the blank lines
 * that separated them from the body. A line carrying any other word — `I love
 * #Apple` — ends the run: those hashtags are the author's sentence.
 *
 * A walk from the last line rather than one regex anchored on `$`: a pattern that
 * restarts at every line break rescans the remainder each time, which is
 * quadratic on a body that is hundreds of lines of hashtags.
 */
function stripTrailingHashtagLines(text: string): string {
  const lines = text.split('\n');
  let end = lines.length;
  let removed = false;
  while (end > 0) {
    const line = lines[end - 1].trim();
    if (line.length > 0 && !HASHTAG_ONLY_LINE.test(line)) break;
    if (line.length > 0) removed = true;
    end -= 1;
  }
  return removed ? lines.slice(0, end).join('\n').trimEnd() : text;
}

/**
 * Result of {@link normalizePostHashtags}: the cleaned, user-visible content and
 * the full set of detected hashtags in canonical form.
 */
export interface NormalizedPostHashtags {
  /** Visible post text: trailing hashtag lines and spammy blocks removed per the rules. */
  content: string;
  /** Every detected hashtag: lowercase, no leading `#`, deduplicated, order preserved. */
  hashtags: string[];
}

/**
 * Centralized post-hashtag normalization. This is the single source of truth for
 * how every post-creation/update path derives the stored `hashtags` field and
 * which hashtags stay in the visible `content` text.
 *
 * Behavior:
 *   1. Detects ALL hashtags in `text` (and merges any caller-supplied tags),
 *      storing them lowercase, without the leading `#`, deduplicated, order
 *      preserved. These ALWAYS land in `hashtags` even when removed from view.
 *   2. TRAILING hashtag lines are removed from `content` whole, whatever their
 *      length: lines at the end of the body made of hashtags and nothing else
 *      (separated only by whitespace), together with the blank lines before
 *      them. Hashtags at the END of a post are filing, not prose — the reader
 *      never sees them, the `hashtags` column carries them. Any other word,
 *      emoji, mention or punctuation on such a line keeps the whole line.
 *   3. Then blocks of {@link SPAM_HASHTAG_BLOCK_THRESHOLD}+ CONSECUTIVE hashtags
 *      left anywhere else — mid-text, or at the end of a line that also carries
 *      words — lose all but their FIRST tag, which may naturally complete the
 *      sentence before it. With no text before the block it is removed whole.
 *   4. Hashtags used inside sentence text (`I love #Apple`, including at the
 *      very end of the post on the same line as other words, up to three in a
 *      row) stay in `content` untouched.
 *   5. A post is NEVER emptied: when nothing visible would remain — a body of
 *      nothing but hashtags — `content` is `text` exactly as given. Those
 *      hashtags ARE the post.
 *
 * Pure, side-effect free and idempotent: a second pass over its own `content`
 * changes nothing (rule 2 leaves a last line with a word on it, rule 3 leaves at
 * most one tag where a block was, and rule 5 hands back a body the rules would
 * empty again). Its callers are named individually
 * — the federated ingest (`connectors/activitypub/apPostContent.ts`) reads both
 * halves, the native write paths read the cleaned `content` through
 * `services/postVariants.ts`'s `stripHiddenHashtags` while deriving the
 * `hashtags` column with `mergeHashtags` over the RAW body, and
 * `scripts/stripTrailingHashtagLines.ts` applies it to bodies stored before rule 2.
 */
export function normalizePostHashtags(
  text: string | undefined | null,
  userProvided?: string[],
): NormalizedPostHashtags {
  const source = typeof text === 'string' ? text : '';
  const hashtags = mergeHashtags(source, userProvided);

  const visible = stripTrailingHashtagLines(source);
  const cleaned = visible
    .replace(
      CONSECUTIVE_HASHTAG_BLOCK,
      (_match, leadingWhitespace: string, block: string, offset: number) => {
        const firstNonSpace = visible.search(/\S/);
        if (firstNonSpace === -1 || firstNonSpace >= offset) {
          // Block sits at the very start (only whitespace before it): drop it whole.
          return '';
        }
        // Preserve the first hashtag so it can complete the preceding sentence,
        // keeping the original leading whitespace; drop the rest of the block.
        const firstTag = block.match(FIRST_HASHTAG)?.[0] ?? '';
        return `${leadingWhitespace}${firstTag}`;
      },
    )
    .replace(/[ \t]+$/g, '');
  const content = cleaned.trim().length === 0 ? source : cleaned;

  return { content, hashtags };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
