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
 * Returns deduplicated array.
 */
export function mergeHashtags(text: string, userProvided?: string[]): string[] {
  const extracted = extractHashtags(text);
  return [...new Set([...(userProvided || []), ...extracted])];
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
