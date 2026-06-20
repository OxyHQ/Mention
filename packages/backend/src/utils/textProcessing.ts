/**
 * Shared text processing utilities for hashtag/mention extraction.
 * Consolidates duplicate regex patterns across controllers.
 */

const HASHTAG_REGEX = /#([A-Za-z0-9_]+)/g;
const MENTION_PLACEHOLDER_REGEX = /\[mention:([^\]]+)\]/g;

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
 * Characters NOT allowed inside a stored hashtag. A canonical hashtag is a run
 * of unicode letters (`\p{L}`), unicode numbers (`\p{N}`), and underscores;
 * everything else — spaces, tabs, newlines, punctuation, emoji, ZWJ/separators —
 * is stripped. The class is unicode-aware (`u` flag) so legitimate
 * international tags federated instances send (Japanese, accented Latin,
 * Cyrillic, etc.) are PRESERVED rather than mangled to ASCII.
 */
const HASHTAG_DISALLOWED_CHARS = /[^\p{L}\p{N}_]+/gu;

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
 * Order: strip leading `#` → trim → lowercase → remove disallowed chars.
 */
export function normalizeHashtag(raw: string): string {
  return raw
    .replace(/^#/, '')
    .trim()
    .toLowerCase()
    .replace(HASHTAG_DISALLOWED_CHARS, '');
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
  const extracted = extractHashtags(text).map(normalizeHashtag).filter((tag) => tag.length > 0);
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
 * Matches a hashtag token. Kept identical to {@link HASHTAG_REGEX} so detection
 * for cleaning and detection for the stored `hashtags` field never diverge.
 */
const HASHTAG_TOKEN = '#[A-Za-z0-9_]+';

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
  'g',
);

/**
 * Result of {@link normalizePostHashtags}: the cleaned, user-visible content and
 * the full set of detected hashtags in canonical form.
 */
export interface NormalizedPostHashtags {
  /** Visible post text with spammy consecutive hashtag blocks removed per the rules. */
  content: string;
  /** Every detected hashtag: lowercase, no leading `#`, deduplicated, order preserved. */
  hashtags: string[];
}

/**
 * Centralized post-hashtag normalization. This is the single source of truth for
 * how every post-creation/update path derives the stored `hashtags` field and
 * cleans spammy hashtag blocks from the visible `content` text.
 *
 * Behavior:
 *   1. Detects ALL hashtags in `text` (and merges any caller-supplied tags),
 *      storing them lowercase, without the leading `#`, deduplicated, order
 *      preserved. These ALWAYS land in `hashtags` even when removed from view.
 *   2. Detects blocks of {@link SPAM_HASHTAG_BLOCK_THRESHOLD}+ CONSECUTIVE
 *      hashtags (separated only by whitespace) and removes the spammy part from
 *      the visible `content`.
 *   3. The FIRST hashtag of a consecutive block is preserved in `content` ONLY
 *      when normal (non-hashtag) text precedes the block — it may naturally
 *      complete the sentence. With no preceding text the whole block is removed.
 *   4. Hashtags used naturally inside sentence text (not part of a 4+ block)
 *      stay in `content` untouched.
 *
 * Pure and side-effect free so it is unit-testable in isolation; the persistence
 * layer (Post schema `pre('validate')` hook and the federated batch insert)
 * invokes it immediately before writing.
 */
export function normalizePostHashtags(text: string | undefined | null, userProvided?: string[]): NormalizedPostHashtags {
  const source = typeof text === 'string' ? text : '';
  const hashtags = mergeHashtags(source, userProvided);

  const content = source.replace(
    CONSECUTIVE_HASHTAG_BLOCK,
    (_match, leadingWhitespace: string, block: string, offset: number) => {
      const hasPrecedingText = source.slice(0, offset).trim().length > 0;
      if (!hasPrecedingText) {
        // Block sits at the very start (only whitespace before it): drop it whole.
        return '';
      }
      // Preserve the first hashtag so it can complete the preceding sentence,
      // keeping the original leading whitespace; drop the rest of the block.
      const firstTag = block.match(new RegExp(HASHTAG_TOKEN))?.[0] ?? '';
      return `${leadingWhitespace}${firstTag}`;
    },
  ).replace(/[ \t]+$/g, '');

  return { content, hashtags };
}

/**
 * Extract mention user IDs from placeholder format [mention:userId].
 */
export function extractMentionIds(text: string): string[] {
  if (!text) return [];
  const matches = Array.from(text.matchAll(MENTION_PLACEHOLDER_REGEX));
  return [...new Set(matches.map((m) => m[1]))];
}

/**
 * Escape special regex characters in a string for safe use in RegExp constructor.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
