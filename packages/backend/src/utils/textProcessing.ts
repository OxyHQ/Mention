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
 * Merge extracted hashtags with user-provided hashtags.
 *
 * Hashtags are stored canonically lowercased so that case-insensitive read
 * paths (`getPostsByHashtag`, the MTN `HashtagFeed`, the `$toLower` trending
 * aggregations) always match. `extractHashtags` already lowercases tags pulled
 * from the text; user-provided tags are normalized here (trimmed + lowercased)
 * before deduplication so a mixed-case `userProvided` entry can never be stored
 * verbatim. Empty entries are dropped.
 *
 * Returns a deduplicated array of lowercase tag names.
 */
export function mergeHashtags(text: string, userProvided?: string[]): string[] {
  const extracted = extractHashtags(text);
  const normalizedUserProvided = (userProvided || [])
    .map((tag) => tag.trim().toLowerCase())
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
