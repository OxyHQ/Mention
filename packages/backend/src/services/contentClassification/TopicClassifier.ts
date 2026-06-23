/**
 * Pluggable topic classification for the Stage-A deterministic baseline.
 *
 * The {@link TopicClassifier} interface is the seam that lets the cheap,
 * deterministic {@link RuleBasedTopicClassifier} be swapped for an
 * AI/embedding-based classifier later WITHOUT changing any call-site: the
 * baseline classifier depends on the interface, not the implementation.
 */

import {
  HASHTAG_TOPIC_MAP,
  KEYWORD_TOPIC_RULES,
  isTopicSlug,
  type TopicSlug,
} from './taxonomy';

/** Minimal, already-normalized input a topic classifier needs. */
export interface TopicClassifierInput {
  /** Lowercased post text (may be empty). */
  text: string;
  /** Canonical hashtags (lowercase, no `#`, alias-mapped, deduped). */
  hashtagsNorm: readonly string[];
}

/**
 * Maps post content to a deduplicated list of canonical topic slugs. Pure and
 * deterministic. Implementations MUST only emit slugs from the canonical
 * taxonomy ({@link TopicSlug}).
 */
export interface TopicClassifier {
  classify(input: TopicClassifierInput): string[];
}

/**
 * Escapes a keyword for safe inclusion in a RegExp. Keywords are static data,
 * but escaping keeps the rules robust if punctuation is ever added.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a single whole-word/phrase, case-insensitive matcher per keyword.
 * Word boundaries (`\b`) prevent substring false positives (e.g. "art" inside
 * "start"). Compiled once at module load from static rules.
 */
const COMPILED_KEYWORD_RULES: ReadonlyArray<{ topic: TopicSlug; patterns: readonly RegExp[] }> =
  KEYWORD_TOPIC_RULES.map(rule => ({
    topic: rule.topic,
    patterns: rule.keywords.map(kw => new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i')),
  }));

/**
 * Deterministic, rule-based topic classifier. Combines two signal sources:
 *  1. Canonical hashtags that directly map to a topic slug.
 *  2. Whole-word keyword/phrase matches in the post text.
 *
 * Hashtag-driven topics are added first (first-seen order preserved), then
 * keyword-driven ones, then deduplicated. Returns `[]` when nothing matches.
 */
export class RuleBasedTopicClassifier implements TopicClassifier {
  classify(input: TopicClassifierInput): string[] {
    const topics: TopicSlug[] = [];

    for (const tag of input.hashtagsNorm) {
      const mapped = HASHTAG_TOPIC_MAP[tag];
      if (mapped) {
        topics.push(mapped);
      }
    }

    if (input.text.length > 0) {
      for (const rule of COMPILED_KEYWORD_RULES) {
        if (rule.patterns.some(pattern => pattern.test(input.text))) {
          topics.push(rule.topic);
        }
      }
    }

    // Dedupe, preserve first-seen order, and defensively drop any non-canonical
    // slug (cannot happen with the static maps, but keeps the contract explicit).
    return [...new Set(topics)].filter(isTopicSlug);
  }
}

/** Default singleton used by the baseline classifier until an AI classifier is injected. */
export const ruleBasedTopicClassifier = new RuleBasedTopicClassifier();
