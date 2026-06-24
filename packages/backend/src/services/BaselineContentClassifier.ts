/**
 * Stage-A deterministic content classifier.
 *
 * Produces the cheap, synchronous, side-effect-free signals that run on EVERY
 * post (native AND federated) on the same code path at ingest:
 *   - languages: ALL detected/declared ISO 639-1 languages (primary first) —
 *     explicitly-provided AP set if any, else tinyld multi-candidate detection,
 *     else `[]` (short/undetectable text). The single canonical language field.
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

import { detectAll as detectAllLanguages } from 'tinyld/light';
import { normalizePostHashtags } from '../utils/textProcessing';
import { HASHTAG_ALIASES } from './contentClassification/taxonomy';
import { isNsfwHashtag } from './contentClassification/nsfw';
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
 *
 * v3: derive `sensitive` from the NSFW/adult hashtag blocklist (canonical
 * hashtags AND hashtags parsed from the visible text), so a `#NSFW`/adult post is
 * marked sensitive even when the federating source never set the flag. The
 * source-provided `sensitive` flag is still honored (OR-combined). Bumped so the
 * version-gated backfill re-marks sensitive across the existing corpus.
 *
 * v4: multi-language support. Detection moved from tinyld's single-best `detect`
 * to the ranked `detectAll`, so a bilingual post (or a Mastodon `contentMap`
 * declaring several languages) now records ALL its languages in
 * `postClassification.languages` (primary first) — not just the dominant one.
 * The classification subdoc now carries ONLY `postClassification.languages`; the
 * primary (`languages[0]`) is written to the top-level `post.language` AP field.
 * Bumped so the version-gated backfill re-derives `languages` across the existing
 * corpus (and migrates off the removed singular `postClassification.language`).
 */
export const BASELINE_CLASSIFIER_VERSION = 4;

/**
 * Minimum number of non-whitespace characters required before attempting
 * language detection. Below this, trigram detection is unreliable (e.g. `"hi"`,
 * emoji-only) so we return `undefined` rather than a confident-but-wrong guess.
 */
const MIN_TEXT_LENGTH_FOR_DETECTION = 12;

/**
 * Multi-language detection policy for {@link detectAllLanguages}. tinyld returns
 * a ranked `[{ lang, accuracy }]` list whose accuracy values are RELATIVE within
 * a single call (a confident monolingual post yields one entry at ~1.0, a
 * monolingual-but-ambiguous post yields a low top score with a long noise tail,
 * and a genuinely bilingual post yields two comparably-scored entries). A single
 * absolute threshold therefore cannot separate "second real language" from
 * "noise", so a SECONDARY candidate must clear BOTH gates below relative to the
 * top candidate. The top candidate is always taken as the primary (best guess).
 */
const LANGUAGE_DETECTION = {
  /**
   * Absolute floor on a SECONDARY candidate's accuracy. Filters the long
   * low-score noise tail tinyld emits for monolingual text (e.g. a Spanish post
   * listing `pt`/`ro`/`hu` at ~0.02). Does NOT apply to the primary, which is the
   * single best guess regardless of absolute score.
   */
  secondaryMinAccuracy: 0.2,
  /**
   * Minimum ratio of a SECONDARY candidate's accuracy to the top candidate's. A
   * real second language scores close to the top (a balanced ES/EN post is ~0.55
   * vs ~0.45, ratio ~0.82); incidental matches score far below it. Combined with
   * the absolute floor this keeps multi-language to genuinely multilingual text.
   */
  secondaryMinRatioToTop: 0.5,
  /**
   * Maximum number of languages recorded for one post (primary + extras). Keeps
   * the multikey `$in`/index footprint small; real posts rarely mix more than a
   * couple of languages.
   */
  maxLanguages: 3,
} as const;

/** Minimal post shape the classifier needs. Framework-agnostic; no Mongoose. */
export interface ClassifyInput {
  /** Visible post text (already plain text). */
  text?: string;
  /** Hashtags from the caller (e.g. AP `tag` array or user-provided). */
  hashtags?: string[];
  /** Explicit PRIMARY language if known (AP `language`, or native param). */
  language?: string;
  /**
   * Explicit FULL set of languages if known (e.g. AP top-level `language` plus
   * every `contentMap` key, via {@link extractApLanguages}). When non-empty this
   * declared set is AUTHORITATIVE — it is used verbatim (normalized to ISO 639-1,
   * deduped) instead of running text detection, because a federating server's own
   * declaration is more reliable than guessing from (often HTML-stripped) text.
   */
  languages?: string[];
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
  /**
   * PRIMARY (dominant/declared) ISO 639-1 language — equals `languages[0]`, or
   * `undefined` when none could be determined. Written ONLY to the TOP-LEVEL
   * `post.language` ActivityPub protocol field, NEVER into the classification
   * subdoc (the subdoc carries the full {@link BaselineSignals.languages} array).
   */
  language?: string;
  /**
   * ALL detected/declared ISO 639-1 languages, primary (dominant/declared) first,
   * deduped, capped at {@link LANGUAGE_DETECTION.maxLanguages}. Empty when none
   * reliable. This is the ONE canonical classification-language signal, stored as
   * `postClassification.languages`.
   */
  languages: string[];
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

    const { primary: language, all: languages } = this.resolveLanguages(input, text);
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

    // Sensitive = the source-provided flag OR any NSFW/adult hashtag. The
    // canonical `hashtagsNorm` already merges the explicit `hashtags` array with
    // hashtags parsed from the visible text, so this single check covers both. We
    // also scan the raw provided hashtags so an entry that an alias remaps away
    // from a blocklisted slug is still caught.
    const sensitive = this.resolveSensitive(input, hashtagsNorm);

    return {
      language,
      languages,
      region,
      hashtagsNorm,
      topics,
      sensitive,
      scores,
      version: BASELINE_CLASSIFIER_VERSION,
      classifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Resolve the post's `sensitive` flag: the source-provided flag OR an NSFW/adult
   * hashtag on the post (from the canonical normalized hashtags — which already
   * include both the explicit `hashtags` array and hashtags parsed from the text —
   * plus the raw provided hashtags, so an alias remap can never hide a blocklisted
   * tag). Returns `true` when either signal is present; otherwise passes the
   * provided flag through unchanged (`false`/`undefined`), so a clean post is
   * never spuriously marked.
   */
  private resolveSensitive(input: ClassifyInput, hashtagsNorm: string[]): boolean | undefined {
    if (input.sensitive === true) return true;

    const hasNsfwHashtag =
      hashtagsNorm.some(isNsfwHashtag) || (input.hashtags ?? []).some(isNsfwHashtag);
    if (hasNsfwHashtag) return true;

    return input.sensitive;
  }

  /**
   * Resolve the post's languages into an ordered ISO 639-1 list (primary first).
   * The primary is simply element 0 (or none when the list is empty). Policy:
   *
   * 1. An explicitly-DECLARED set (federated AP: top-level `language` + every
   *    `contentMap` key) is AUTHORITATIVE — normalized to ISO 639-1, deduped,
   *    capped — and used verbatim instead of detection. The single explicit
   *    `language` is folded in as the leading element so a server that declares
   *    only the top-level field still yields a one-element list.
   * 2. Otherwise (native posts), detect from text when it is long enough to be
   *    reliable, using tinyld's ranked `detectAll`: the top candidate is the
   *    primary, and additional candidates are kept only when they clear both the
   *    absolute and relative gates in {@link LANGUAGE_DETECTION}.
   */
  private resolveLanguages(
    input: Pick<ClassifyInput, 'language' | 'languages'>,
    trimmedText: string,
  ): { primary: string | undefined; all: string[] } {
    // (1) Explicit declared set wins. Merge the single `language` (leading) with
    // the `languages` list, normalize each, dedupe (first-seen order), cap.
    const declared = this.dedupeLanguages(
      [input.language, ...(input.languages ?? [])]
        .map(normalizeProvidedLanguage)
        .filter((code): code is string => code !== undefined),
    ).slice(0, LANGUAGE_DETECTION.maxLanguages);

    if (declared.length > 0) {
      return { primary: declared[0], all: declared };
    }

    // (2) Detect from text. Too-short input is unreliable → no language.
    if (trimmedText.length < MIN_TEXT_LENGTH_FOR_DETECTION) return { primary: undefined, all: [] };

    const detected = this.selectDetectedLanguages(trimmedText);
    return { primary: detected[0], all: detected };
  }

  /**
   * Run tinyld's ranked multi-candidate detection and select the languages to
   * keep: the top candidate (the single best guess) plus any further candidate
   * that clears BOTH the absolute accuracy floor AND the ratio-to-top gate. Only
   * ISO 639-1 codes are kept; the result is deduped and capped.
   */
  private selectDetectedLanguages(trimmedText: string): string[] {
    const ranked = detectAllLanguages(trimmedText).filter(
      (candidate) => candidate.lang.length === ISO_639_1_LENGTH,
    );
    if (ranked.length === 0) return [];

    const topAccuracy = ranked[0].accuracy;
    const selected: string[] = [ranked[0].lang];

    for (const candidate of ranked.slice(1)) {
      if (selected.length >= LANGUAGE_DETECTION.maxLanguages) break;
      const clearsFloor = candidate.accuracy >= LANGUAGE_DETECTION.secondaryMinAccuracy;
      const clearsRatio =
        topAccuracy > 0 &&
        candidate.accuracy / topAccuracy >= LANGUAGE_DETECTION.secondaryMinRatioToTop;
      if (clearsFloor && clearsRatio) {
        selected.push(candidate.lang);
      }
    }

    return this.dedupeLanguages(selected);
  }

  /** Dedupe ISO 639-1 codes, preserving first-seen order. */
  private dedupeLanguages(codes: string[]): string[] {
    return [...new Set(codes)];
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
