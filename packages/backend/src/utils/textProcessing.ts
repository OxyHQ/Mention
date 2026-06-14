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
 * Canonical hashtag normalization.
 *
 * Strips a single leading `#`, trims surrounding whitespace, and lowercases so
 * that every write path stores tags in the same form the case-insensitive read
 * paths (`getPostsByHashtag`, the MTN `HashtagFeed`, the `$toLower` trending
 * aggregations) expect. Returns `''` for empty/whitespace-only input so callers
 * can filter out non-tags. This is the single source of truth for the recipe
 * that was previously duplicated across the native and federated write paths.
 */
export function normalizeHashtag(raw: string): string {
  return raw.replace(/^#/, '').trim().toLowerCase();
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
