/**
 * Stage-A deterministic content classifier.
 *
 * Produces the cheap, synchronous, side-effect-free signals that run on EVERY
 * post (native AND federated) on the same code path at ingest:
 *   - language: explicitly-provided language, else lightweight detection, else
 *     `undefined` (short/undetectable text)
 *   - region: best-effort, nullable (from a federated instance domain or locale)
 *   - hashtagsNorm: canonical hashtags via the shared post-hashtag normalizer
 *     (NOT a parallel normalizer), with the alias map applied
 *   - topics: rule-based, behind the {@link TopicClassifier} interface so an
 *     AI/embedding classifier can replace it later with no call-site change
 *   - sensitive: pass-through of the provided flag
 *
 * This is intentionally SEPARATE from the async AI {@link PostClassificationService}
 * (Stage B): both write into the single `postClassification` object on the Post,
 * but this one is deterministic and runs inline at ingest. No DB, no network —
 * so it is cheap and trivially unit-testable.
 *
 * The output is NOT wired into any ingest path here (P1 is foundation only);
 * wiring happens in P2.
 */

import { detect as detectLanguage } from 'tinyld/light';
import { normalizePostHashtags } from '../utils/textProcessing';
import { HASHTAG_ALIASES } from './contentClassification/taxonomy';
import { deriveRegion } from './contentClassification/region';
import {
  ruleBasedTopicClassifier,
  type TopicClassifier,
} from './contentClassification/TopicClassifier';
import type { PostClassificationScores } from '@mention/shared-types';
import {
  computeDeterministicScores,
  toClassificationScores,
} from './contentClassification/spamQuality';

/**
 * Version of the deterministic ruleset (taxonomy + maps + detection policy +
 * spam/quality heuristics). Bump when ANY of those change so posts can be
 * re-baselined. Stored on each post's `postClassification.version`.
 *
 * v2: added deterministic spam/quality/toxicity scores + expanded taxonomy
 * coverage (so the version-gated backfill re-processes existing posts and writes
 * the new `postClassification.scores`).
 */
export const BASELINE_CLASSIFIER_VERSION = 2;

/**
 * Minimum number of non-whitespace characters required before attempting
 * language detection. Below this, trigram detection is unreliable (e.g. `"hi"`,
 * emoji-only) so we return `undefined` rather than a confident-but-wrong guess.
 */
const MIN_TEXT_LENGTH_FOR_DETECTION = 12;

/** Minimal post shape the classifier needs. Framework-agnostic; no Mongoose. */
export interface ClassifyInput {
  /** Visible post text (already plain text). */
  text?: string;
  /** Hashtags from the caller (e.g. AP `tag` array or user-provided). */
  hashtags?: string[];
  /** Explicit language if known (AP `language`/`contentMap`, or native param). */
  language?: string;
  /** Sensitive/NSFW flag to pass through. */
  sensitive?: boolean;
  /** Whether this post came from a federated instance. */
  isFederated?: boolean;
  /** Federated instance domain (host), when known. Used for region only. */
  instanceDomain?: string;
  /** Author locale (e.g. `"es-ES"`), when known. Weak region fallback. */
  authorLocale?: string;
}

/** Deterministic Stage-A signals produced by {@link BaselineContentClassifier.classify}. */
export interface BaselineSignals {
  language?: string;
  region?: string;
  hashtagsNorm: string[];
  topics: string[];
  sensitive?: boolean;
  /**
   * Content-classification scores stored into `postClassification.scores` so the
   * SAME ranking path can downrank spam / low-quality posts before any AI runs.
   * Only `spam`, `quality`, and `toxicity` are computed deterministically; the
   * AI-only fields (`constructiveness`, `controversy`, `negativity`) carry the
   * neutral `0` baseline. The async AI batch OVERWRITES the whole object with
   * higher-fidelity values when a key is configured (the intended hybrid).
   */
  scores: PostClassificationScores;
  version: number;
  classifiedAt: string;
}

/** Length of an ISO 639-1 primary language subtag. */
const ISO_639_1_LENGTH = 2;

/**
 * Normalizes an explicit language tag to its ISO 639-1 primary subtag
 * (`"pt-BR"` → `"pt"`). Returns `undefined` for non-usable input.
 */
function normalizeProvidedLanguage(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  const primary = tag.trim().toLowerCase().split('-')[0];
  if (primary.length !== ISO_639_1_LENGTH) return undefined;
  if (!/^[a-z]{2}$/.test(primary)) return undefined;
  return primary;
}

export class BaselineContentClassifier {
  /**
   * @param topicClassifier the topic strategy. Defaults to the rule-based one;
   *   injectable so an AI/embedding classifier can be swapped in later (or stubbed
   *   in tests) with no change to callers.
   */
  constructor(private readonly topicClassifier: TopicClassifier = ruleBasedTopicClassifier) {}

  /**
   * Classify a post into deterministic Stage-A signals. Pure: no DB, no network,
   * no mutation of the input. Same behavior for native and federated posts.
   */
  classify(input: ClassifyInput): BaselineSignals {
    const text = (input.text ?? '').trim();

    // Hashtags: reuse the single source of truth for post-hashtag normalization,
    // then collapse known variants via the alias map and dedupe again.
    const { hashtags: normalized } = normalizePostHashtags(input.text, input.hashtags);
    const hashtagsNorm = this.applyHashtagAliases(normalized);

    const language = this.resolveLanguage(input.language, text);
    const region = deriveRegion({
      isFederated: input.isFederated,
      instanceDomain: input.instanceDomain,
      authorLocale: input.authorLocale,
    });

    const topics = this.topicClassifier.classify({
      text: text.toLowerCase(),
      hashtagsNorm,
    });

    // Deterministic spam/quality/toxicity from the ORIGINAL-case text (caps ratio
    // needs case) and the canonical hashtag count (so the heuristics agree with
    // the rest of the classifier on what counts as a hashtag). Lifted into the
    // full scores shape (AI-only fields neutral) for storage.
    const scores = toClassificationScores(
      computeDeterministicScores(input.text ?? '', hashtagsNorm.length),
    );

    return {
      language,
      region,
      hashtagsNorm,
      topics,
      sensitive: input.sensitive,
      scores,
      version: BASELINE_CLASSIFIER_VERSION,
      classifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Prefer an explicitly-provided language (AP carries it; native may pass it).
   * Otherwise detect from text when it is long enough to be reliable. Detection
   * returns `''` for unknown/too-short input — normalized to `undefined`.
   */
  private resolveLanguage(provided: string | undefined, trimmedText: string): string | undefined {
    const explicit = normalizeProvidedLanguage(provided);
    if (explicit) return explicit;

    if (trimmedText.length < MIN_TEXT_LENGTH_FOR_DETECTION) return undefined;

    const detected = detectLanguage(trimmedText);
    return detected.length === ISO_639_1_LENGTH ? detected : undefined;
  }

  /**
   * Apply the canonical hashtag alias map and re-dedupe, preserving first-seen
   * order. Input is already normalized (lowercase, no `#`).
   */
  private applyHashtagAliases(hashtags: string[]): string[] {
    const aliased = hashtags.map(tag => HASHTAG_ALIASES[tag] ?? tag);
    return [...new Set(aliased)];
  }
}

/** Default singleton (rule-based topics). */
export const baselineContentClassifier = new BaselineContentClassifier();
