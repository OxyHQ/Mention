/**
 * Deterministic spam / quality / toxicity heuristics for the Stage-A baseline
 * classifier ({@link ../BaselineContentClassifier}).
 *
 * These produce a normalized {@link DeterministicScores} subset (`spam`,
 * `quality`, `toxicity` — each a 0..1 probability) WITHOUT any AI, DB, or
 * network. They run inline on EVERY post (native + federated) at ingest, so they
 * must be PURE and cheap. The output is stored into `postClassification.scores`
 * with a non-`classified` status; when an AI key is later configured, the async
 * batch OVERWRITES `scores` wholesale with higher-fidelity values (the intended
 * hybrid). Meanwhile the SAME ranking path honors these baseline scores so
 * spam/low-quality posts are downranked in For You deterministically.
 *
 * Everything is data-driven via named constants — NO magic numbers — so the
 * heuristics are auditable and easy to tune.
 */

import type { PostClassificationScores } from '@mention/shared-types';

/** The deterministic 0..1 score subset this module actually computes. */
export interface DeterministicScores {
  /** Likelihood the content is spam / low-effort promotion (0..1). */
  spam: number;
  /** Overall content quality — clarity, substance, effort (0..1). */
  quality: number;
  /** Likelihood the content is toxic / abusive, from a small profanity list (0..1). */
  toxicity: number;
}

/**
 * Tunable thresholds + weights for the deterministic heuristics. Grouped by
 * signal so the rules read as one auditable config block. All limits are
 * inclusive lower bounds ("at or above" triggers) unless noted.
 */
export const SPAM_QUALITY_CONFIG = {
  spam: {
    /**
     * Hashtag count at/above which a post looks like a hashtag dump. Each extra
     * hashtag beyond this adds `hashtagStep` spam, capped by `hashtagMax`.
     */
    hashtagThreshold: 5,
    /** Spam added per hashtag over `hashtagThreshold`. */
    hashtagStep: 0.12,
    /** Maximum spam contribution from the hashtag signal. */
    hashtagMax: 0.45,

    /**
     * URL count at/above which a post looks link-spammy. Each extra link beyond
     * this adds `linkStep` spam, capped by `linkMax`.
     */
    linkThreshold: 2,
    /** Spam added per URL over `linkThreshold`. */
    linkStep: 0.18,
    /** Maximum spam contribution from the multi-link signal. */
    linkMax: 0.45,

    /**
     * A post whose non-URL, non-hashtag text is at/under this many characters
     * while still containing at least one link is "link-only" — a classic
     * drive-by promo shape. Adds a flat `linkOnlyWeight`.
     */
    linkOnlyMaxTextLength: 12,
    /** Spam added for a link-only post. */
    linkOnlyWeight: 0.4,

    /**
     * @-mention count at/above which a post looks like mention-spam. Each extra
     * mention beyond this adds `mentionStep`, capped by `mentionMax`.
     */
    mentionThreshold: 4,
    /** Spam added per mention over `mentionThreshold`. */
    mentionStep: 0.12,
    /** Maximum spam contribution from the mention signal. */
    mentionMax: 0.36,

    /**
     * All-caps shouting: the fraction of cased letters that are uppercase. Only
     * evaluated when the post has at least `capsMinLetters` cased letters (so a
     * short "OK" never trips it). At/above `capsRatioThreshold` adds `capsWeight`.
     */
    capsMinLetters: 12,
    capsRatioThreshold: 0.7,
    /** Spam added for a shouting (mostly-caps) post. */
    capsWeight: 0.3,

    /**
     * Character looping / flooding: the longest run of a single repeated
     * character at/above this length (e.g. "buyyyyyyy", "!!!!!!!!!!") adds
     * `repeatWeight`.
     */
    repeatRunThreshold: 8,
    /** Spam added for repeated-character flooding. */
    repeatWeight: 0.25,

    /**
     * Short promo: a post at/under `promoMaxTextLength` characters that contains
     * a promotional keyword AND a link is a classic "buy now <link>" promo. Adds
     * `promoWeight`.
     */
    promoMaxTextLength: 80,
    /** Spam added for a short text + promotional keyword + link. */
    promoWeight: 0.3,
  },

  quality: {
    /**
     * Quality baseline before adjustments. Heuristics push UP for substance and
     * DOWN for low-effort shapes, then the result is clamped to 0..1.
     */
    base: 0.5,

    /**
     * Visible (URL/hashtag/mention-stripped) text length tiers that earn a
     * length-quality contribution. A post needs real words, not just links/tags.
     */
    substantialTextLength: 80,
    /** Quality added for substantial text length. */
    substantialBoost: 0.2,
    mediumTextLength: 30,
    /** Quality added for medium text length. */
    mediumBoost: 0.1,

    /**
     * Sentence structure: at least this many sentence terminators (`.`, `!`, `?`)
     * indicates composed prose rather than a one-liner / dump. Adds
     * `sentenceBoost`.
     */
    sentenceMinTerminators: 2,
    /** Quality added for multi-sentence structure. */
    sentenceBoost: 0.12,

    /**
     * Very-low-effort shapes that subtract quality:
     *  - visible text at/under `tinyTextLength` chars,
     *  - link-only (handled via the same threshold as spam's link-only),
     *  - all-emoji / no letters,
     *  - pure hashtag dump (no visible words, only hashtags).
     */
    tinyTextLength: 8,
    /** Quality removed for a tiny / empty-of-substance post. */
    tinyPenalty: 0.3,
    /** Quality removed for an all-emoji / no-letter post. */
    noLetterPenalty: 0.35,
    /** Quality removed for a pure-hashtag-dump post (tags but no words). */
    hashtagDumpPenalty: 0.3,
    /**
     * Quality is dragged down toward (but not below) this floor by the post's
     * own spam score: `quality *= (1 - spam * spamQualityCoupling)` is NOT used;
     * instead high spam directly removes `spamPenalty * spam`. Keeps the two
     * signals coherent (a spammy post is also low quality) without making them
     * identical.
     */
    spamPenalty: 0.4,
  },

  toxicity: {
    /**
     * Each distinct profanity/slur term found contributes `perTermWeight`,
     * capped at `max`. Deliberately conservative — this is a tiny, high-signal
     * wordlist, not a moderation engine; the AI batch supersedes it when present.
     */
    perTermWeight: 0.4,
    max: 0.9,
  },
} as const;

/**
 * Promotional keywords that, combined with a short post + a link, signal a
 * drive-by promo. Whole-word matched, case-insensitive.
 */
const PROMO_KEYWORDS: readonly string[] = [
  'buy now',
  'buy',
  'discount',
  'promo',
  'promo code',
  'coupon',
  'free shipping',
  'limited offer',
  'click here',
  'sign up now',
  'subscribe now',
  'follow back',
  'follow me',
  'dm me',
  'check my profile',
  'giveaway',
  'crypto giveaway',
  'airdrop',
  'investment opportunity',
  'make money',
  'work from home',
  'earn cash',
  'best price',
  'order now',
  'shop now',
];

/**
 * Small, high-signal profanity/slur wordlist for a coarse deterministic toxicity
 * estimate. Intentionally minimal: it catches the obvious cases that should be
 * downranked even before any AI runs, and is fully replaced by the AI toxicity
 * score when a key is configured. Whole-word, case-insensitive.
 */
const PROFANITY_TERMS: readonly string[] = [
  'fuck',
  'fucking',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'cunt',
  'dickhead',
  'motherfucker',
  'retard',
  'faggot',
  'nigger',
  'whore',
  'slut',
];

/** Matches HTTP(S) URLs. */
const URL_PATTERN = /https?:\/\/[^\s]+/gi;
/** Matches a hashtag token. */
const HASHTAG_PATTERN = /#[\p{L}\p{N}_]+/gu;
/** Matches an @-mention token. */
const MENTION_PATTERN = /@[\p{L}\p{N}_.-]+/gu;
/** Matches any cased letter (for the caps ratio). */
const LETTER_PATTERN = /\p{L}/u;
const UPPER_LETTER_PATTERN = /\p{Lu}/u;
/** Sentence terminators. */
const SENTENCE_TERMINATORS = /[.!?]/g;

/** Escapes a static keyword for safe inclusion in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word/phrase, case-insensitive matchers compiled once from the lists. */
const PROMO_PATTERNS: readonly RegExp[] = PROMO_KEYWORDS.map(
  kw => new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i'),
);
const PROFANITY_PATTERNS: readonly RegExp[] = PROFANITY_TERMS.map(
  term => new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i'),
);

/** Clamp a number into the inclusive 0..1 range. */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Longest run of a single repeated character in the string. */
function longestRepeatRun(text: string): number {
  let longest = 0;
  let current = 0;
  let previous = '';
  for (const char of text) {
    if (char === previous) {
      current += 1;
    } else {
      current = 1;
      previous = char;
    }
    if (current > longest) longest = current;
  }
  return longest;
}

/**
 * Visible text with URLs, hashtags, and mentions removed, collapsed whitespace.
 * This is the "substance" of the post — what's left after the link/tag/mention
 * scaffolding — and is what quality/length heuristics measure.
 */
function visibleText(text: string): string {
  return text
    .replace(URL_PATTERN, ' ')
    .replace(HASHTAG_PATTERN, ' ')
    .replace(MENTION_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pre-extracted, reusable counts so spam + quality + toxicity share one parse. */
interface TextFeatures {
  rawText: string;
  visible: string;
  urlCount: number;
  hashtagCount: number;
  mentionCount: number;
  capsRatio: number;
  capsLetters: number;
  longestRun: number;
  sentenceTerminators: number;
  hasLetters: boolean;
}

/** Extract every feature the heuristics need from a post's text in one pass. */
function extractFeatures(rawText: string, hashtagCount: number): TextFeatures {
  const visible = visibleText(rawText);

  const urlCount = (rawText.match(URL_PATTERN) ?? []).length;
  const mentionCount = (rawText.match(MENTION_PATTERN) ?? []).length;

  let casedLetters = 0;
  let upperLetters = 0;
  for (const char of rawText) {
    if (LETTER_PATTERN.test(char)) {
      casedLetters += 1;
      if (UPPER_LETTER_PATTERN.test(char)) upperLetters += 1;
    }
  }
  const capsRatio = casedLetters > 0 ? upperLetters / casedLetters : 0;

  return {
    rawText,
    visible,
    urlCount,
    hashtagCount,
    mentionCount,
    capsRatio,
    capsLetters: casedLetters,
    longestRun: longestRepeatRun(rawText),
    sentenceTerminators: (visible.match(SENTENCE_TERMINATORS) ?? []).length,
    hasLetters: LETTER_PATTERN.test(visible),
  };
}

/** Whether the text contains a promotional keyword/phrase. */
function hasPromoKeyword(text: string): boolean {
  return PROMO_PATTERNS.some(pattern => pattern.test(text));
}

/** Count of DISTINCT profanity terms present (so repeats don't over-count). */
function profanityHitCount(text: string): number {
  let hits = 0;
  for (const pattern of PROFANITY_PATTERNS) {
    if (pattern.test(text)) hits += 1;
  }
  return hits;
}

/** Compute the bounded 0..1 spam score from the extracted features. */
function computeSpam(features: TextFeatures): number {
  const cfg = SPAM_QUALITY_CONFIG.spam;
  let spam = 0;

  // Excessive hashtags.
  if (features.hashtagCount >= cfg.hashtagThreshold) {
    const over = features.hashtagCount - cfg.hashtagThreshold + 1;
    spam += Math.min(cfg.hashtagMax, over * cfg.hashtagStep);
  }

  // Excessive links.
  if (features.urlCount >= cfg.linkThreshold) {
    const over = features.urlCount - cfg.linkThreshold + 1;
    spam += Math.min(cfg.linkMax, over * cfg.linkStep);
  }

  // Link-only / very-low-text-with-link.
  if (features.urlCount > 0 && features.visible.length <= cfg.linkOnlyMaxTextLength) {
    spam += cfg.linkOnlyWeight;
  }

  // Excessive @-mentions.
  if (features.mentionCount >= cfg.mentionThreshold) {
    const over = features.mentionCount - cfg.mentionThreshold + 1;
    spam += Math.min(cfg.mentionMax, over * cfg.mentionStep);
  }

  // All-caps shouting (only with enough cased letters to be meaningful).
  if (features.capsLetters >= cfg.capsMinLetters && features.capsRatio >= cfg.capsRatioThreshold) {
    spam += cfg.capsWeight;
  }

  // Repeated-character / looping flood.
  if (features.longestRun >= cfg.repeatRunThreshold) {
    spam += cfg.repeatWeight;
  }

  // Short + promotional + link.
  if (
    features.urlCount > 0 &&
    features.visible.length <= cfg.promoMaxTextLength &&
    hasPromoKeyword(features.rawText)
  ) {
    spam += cfg.promoWeight;
  }

  return clampUnit(spam);
}

/** Compute the bounded 0..1 quality score from features + the spam score. */
function computeQuality(features: TextFeatures, spam: number): number {
  const cfg = SPAM_QUALITY_CONFIG.quality;
  let quality = cfg.base;

  const visibleLength = features.visible.length;

  // Length-driven substance.
  if (visibleLength >= cfg.substantialTextLength) {
    quality += cfg.substantialBoost;
  } else if (visibleLength >= cfg.mediumTextLength) {
    quality += cfg.mediumBoost;
  }

  // Sentence structure.
  if (features.sentenceTerminators >= cfg.sentenceMinTerminators) {
    quality += cfg.sentenceBoost;
  }

  // Low-effort penalties.
  if (visibleLength <= cfg.tinyTextLength) {
    quality -= cfg.tinyPenalty;
  }
  if (!features.hasLetters) {
    // All-emoji / numbers-only / pure punctuation — no real words.
    quality -= cfg.noLetterPenalty;
  }
  if (features.hashtagCount > 0 && !features.hasLetters) {
    // Pure hashtag dump: hashtags present but no visible words.
    quality -= cfg.hashtagDumpPenalty;
  }

  // A spammy post is also low quality — couple them without making them identical.
  quality -= cfg.spamPenalty * spam;

  return clampUnit(quality);
}

/** Compute the bounded 0..1 toxicity score from the profanity wordlist. */
function computeToxicity(features: TextFeatures): number {
  const cfg = SPAM_QUALITY_CONFIG.toxicity;
  const hits = profanityHitCount(features.rawText);
  if (hits === 0) return 0;
  return clampUnit(Math.min(cfg.max, hits * cfg.perTermWeight));
}

/**
 * Compute the deterministic `spam` / `quality` / `toxicity` scores for a post.
 * Pure: no DB, no network, no mutation. `text` is the visible post text;
 * `hashtagCount` is the count of canonical hashtags resolved upstream (so the
 * spam/quality heuristics agree with the rest of the classifier on what counts
 * as a hashtag, including any pulled from the text).
 */
export function computeDeterministicScores(text: string, hashtagCount: number): DeterministicScores {
  const features = extractFeatures(text ?? '', hashtagCount);
  const spam = computeSpam(features);
  const quality = computeQuality(features, spam);
  const toxicity = computeToxicity(features);
  return { spam, quality, toxicity };
}

/**
 * Lift the deterministic 3-field result into the full {@link PostClassificationScores}
 * shape stored on `postClassification.scores`. The AI-only fields
 * (`constructiveness`, `controversy`, `negativity`) are set to the neutral `0`
 * baseline — identical to the schema default — since they cannot be inferred
 * deterministically; the async AI batch OVERWRITES the whole object with real
 * values when a key is configured (the intended hybrid).
 */
export function toClassificationScores(scores: DeterministicScores): PostClassificationScores {
  return {
    spam: scores.spam,
    quality: scores.quality,
    toxicity: scores.toxicity,
    constructiveness: 0,
    controversy: 0,
    negativity: 0,
  };
}
