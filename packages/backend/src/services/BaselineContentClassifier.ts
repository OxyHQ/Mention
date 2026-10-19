/**
 * Stage-A deterministic content classifier.
 *
 * Produces the cheap, side-effect-free signals that run on EVERY
 * post (native AND federated) on the same code path at ingest:
 *   - languages: ALL detected/declared ISO 639-1 languages (primary first) —
 *     languages verified from the visible body via script evidence / ELD
 *     (`eld`, the n-gram language detector), else `[]` (short, ambiguous, or
 *     contradictory text).
 *   - region: best-effort, nullable (from a federated instance domain or locale)
 *   - hashtagsNorm: canonical hashtags via the shared post-hashtag normalizer
 *     (NOT a parallel normalizer), with the alias map applied
 *   - trendTerms: the words and adjacent-word phrases the post is about, with
 *     the `#` marker stripped so a hashtag and the bare word are ONE term — the
 *     vocabulary trend detection counts in
 *   - topics: rule-based, behind the {@link TopicClassifier} interface so an
 *     AI/embedding classifier can replace it later with no call-site change
 *   - sensitive: pass-through of the provided flag
 *
 * This is intentionally SEPARATE from the async AI {@link PostClassificationService}
 * (Stage B): both write into the single `postClassification` object on the Post,
 * but this one is deterministic and runs inline at ingest. No DB, no network —
 * so it is cheap and trivially unit-testable. `classify` is async only because
 * the language detector is an ESM-only package this CommonJS service loads with
 * a dynamic `import()` (once, cached); the classification itself is pure.
 */

import type { eld as LanguageDetector } from 'eld/extrasmall' with { 'resolution-mode': 'import' };
import { normalizePostHashtags } from '../utils/textProcessing';
import { extractTrendTerms, stripNonProse } from './trending/termExtraction';
import { canonicalHashtag } from './contentClassification/taxonomy';
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
 *
 * v5: HARDENED spam/quality against low-effort + bot junk so the deterministic
 * scores are trustworthy enough for the discovery gate to act on. New pure
 * detectors feed `computeDeterministicScores`: low-effort shapes (custom-emoji
 * `:shortcode:`-only and Unicode-emoji-only posts, which carry "letters" but no
 * prose — see `contentClassification/lowEffort`) and bot shapes (RSS/bridge/
 * Service/Application mirrors + link-only news bots — see
 * `contentClassification/botSignals`). These raise spam / lower quality for the
 * junk while leaving normal real-text prose (including off-language) UNCHANGED —
 * off-language is a ranking concern, not a classification one. Federated ingest
 * now threads the AP actor `type` through as {@link ClassifyInput.actorType}.
 * Bumped so the version-gated backfill re-stamps the corpus with the stronger
 * scores; note that until the backfill runs, existing baseline-only v4 posts fall
 * below the provenance bar and read as NEUTRAL in ranking (AI-`classified` posts
 * are trusted via status and are unaffected).
 *
 * v6: TREND TERMS. Every post now carries `postClassification.trendTerms` — the
 * unigrams and adjacent-word phrases its own text is about, with the `#` marker
 * stripped so a hashtag and the bare word are one term (see
 * {@link ./trending/termExtraction}). This is what lets trending measure a burst
 * in PROSE instead of ranking whoever typed a `#`. Bumped so the version-gated
 * backfill populates the field across the existing corpus; until it runs,
 * trending still sees those posts through the hashtag/topic half of its term
 * union, so the only cost of an un-backfilled post is that its untagged prose
 * does not count yet.
 *
 * v7: a bare trend term must NAME something. A single word is emitted only when
 * it is capitalized MID-SENTENCE (or arrives as a hashtag); a phrase needs one
 * such word. The live list had become `Love`, `Mal`, `Hope` — words rather than
 * stories — and no stop-word list closes that gap, because the next leak is
 * always a content word in a language nobody listed. Capitalization is written
 * in the text itself, needs no vocabulary, and in German selects exactly the
 * nouns. Bumped so the version-gated backfill re-derives terms across the
 * corpus; until it runs, older posts keep their broader v6 terms.
 *
 * v8: that last sentence was wrong, and wrong in the direction that mattered.
 * "In German selects exactly the nouns" was written as if selecting nouns were
 * the goal — but German capitalizes EVERY noun, so in German the rule selected
 * the dictionary rather than the names in it. `Tag` ("day") reached the live
 * list from eight posts wishing each other a good day, alongside `Menschen`,
 * `Luft` and `Land`. Capitalization is now read as evidence of naming only in
 * languages where it discriminates; in the others a term must arrive as a
 * hashtag its author chose. Bumped so the backfill re-derives terms — until it
 * runs, posts stamped v7 keep the German nouns they were extracted with.
 *
 * v9: only complete naming runs become stored trend terms. A capitalized name
 * longer than the phrase limit previously leaked each window as an
 * independent candidate (`New York City` donated `city` and `york city`). An
 * alias is still learned when authors actually write that shorter form on its
 * own. Bumped so the corpus loses those legacy fragments during rebaseline.
 *
 * v10: a single declared language is corrected when deterministic detection
 * strongly contradicts it. Some federated servers stamp their account default
 * (`en`) onto unrelated prose, which placed clearly German posts in English
 * discovery feeds. Multilingual declarations remain authoritative because the
 * primary body cannot validate every authored `contentMap` rendition.
 *
 * v11: language membership is fail-closed. Script evidence corrects bogus CJK
 * declarations for scripts that uniquely identify a supported language;
 * an undeclared body needs a minimum confidence; and a multilingual declaration
 * no longer makes every label eligible merely because it was supplied.
 *
 * Still v11, deliberately. The "minimum confidence" above was measured with
 * tinyld, whose `accuracy` is a share of characters rather than a confidence:
 * plain Spanish and English prose in short clauses scored ~0.2 and was left
 * with NO language, and its light model has no Catalan, Danish, Czech or
 * Slovak at all (Catalan read as `fr`). Detection now uses ELD (60 languages,
 * including those four) gated on its own reliability flag and score margin,
 * on the post's prose rather than its links/placeholders/emoji/markdown. The
 * version is NOT bumped because a bump makes ranking distrust every v11 row's
 * deterministic scores (`trustedScores.ts`) until a full-corpus pass re-stamps
 * them; the language backfill re-derives languages instead
 * (`backfillPostLanguages --all`), which touches only the language fields.
 */
export const BASELINE_CLASSIFIER_VERSION = 11;

/**
 * Language detection policy over ELD's result.
 *
 * ELD scores every supported language against the text; the scores are
 * similarities, so related languages always sit close together (a Spanish post
 * scores `es` 0.80 and `pt` 0.67). What separates a real answer from a guess is
 * the MARGIN between the top two, together with ELD's own `isReliable()` (enough
 * n-grams, a top score near that language's typical score). Measured on short
 * posts in the languages Mention carries, correct answers had a margin of 0.06
 * or more (Danish against Norwegian, the closest pair, 0.025); the wrong ones a
 * detector without the language produces — Galician read as `es`/`pt`, Slovak
 * tied with Czech, Latin read as `fr` — stayed under 0.035.
 */
const LANGUAGE_DETECTION = {
  /** Top score minus runner-up required before a body is assigned a language. */
  minMargin: 0.04,
  /**
   * The prose an UNDECLARED body needs before it is given a language at all —
   * letters and words of the text left after links, placeholders, handles,
   * emoji and markdown are removed, not characters of the raw body.
   */
  fillMinLetters: 12,
  fillMinWords: 3,
  /**
   * Overruling a language the post already carries — the author's, the
   * origin's AP `language`, or the classification it was stored under — is a
   * different claim from filling an empty one, and needs strong evidence: this
   * much prose, a reliable verdict, a margin over the runner-up AND over the
   * carried language's own score, and a carried language the detector knows.
   * Measured on the production review: "wir müssen die dinge bananen nennen"
   * (six words, `de` 0.79 against `nl` 0.70) is not enough to call German
   * anything else, and an English paragraph is ample to correct a `de` default.
   */
  overruleMinLetters: 40,
  overruleMinWords: 5,
  overruleMinMargin: 0.1,
  overruleMinMarginOverCarried: 0.15,
  /**
   * Writing-system evidence is decisive only when that script IS the text:
   * kana (+ Han) or hangul must be at least this share of its letters. One
   * `きんかくじ` in an English paragraph about Kinkaku-ji is a quotation, not
   * Japanese.
   */
  scriptMinShare: 0.5,
  /**
   * A post is multilingual when its sentences say so: a language other than the
   * primary is kept when the sentences confidently detected as it hold at least
   * this share of the post's detectable text.
   */
  secondaryMinShare: 0.3,
  /** Sentences shorter than this are too short to vote on a secondary language. */
  minSegmentLength: 20,
  /**
   * Maximum number of languages recorded for one post (primary + extras). Keeps
   * the multikey `$in`/index footprint small; real posts rarely mix more than a
   * couple of languages.
   */
  maxLanguages: 3,
} as const;

type Detector = typeof LanguageDetector;

let detectorLoad: Promise<Detector> | undefined;

/**
 * The ELD detector with its extra-small n-gram set (~1 MB, ~60 MB resident once
 * loaded, ~0.015 ms per post). ESM-only, so it is loaded with a dynamic import,
 * once per process, as `utils/kaana.ts` loads its SDK.
 */
function languageDetector(): Promise<Detector> {
  detectorLoad ??= import('eld/extrasmall').then((module) => module.eld);
  return detectorLoad;
}

/** A language ELD named reliably, by a clear margin over the runner-up. */
interface ConfidentLanguage {
  language: string;
  margin: number;
}

function detectConfident(detector: Detector, text: string): ConfidentLanguage | undefined {
  const result = detector.detect(text);
  const language = normalizeProvidedLanguage(result.language);
  if (!language || !result.isReliable()) return undefined;
  const [top = 0, second = 0] = Object.values(result.getScores()).sort((a, b) => b - a);
  const margin = top - second;
  return margin >= LANGUAGE_DETECTION.minMargin ? { language, margin } : undefined;
}

let detectorLanguages: ReadonlySet<string> | undefined;

/**
 * Whether the detector has a model for this language at all. A language it
 * lacks (Galician, Welsh, Esperanto, Latin) can only ever be read as a
 * neighbour, so its verdict is no evidence against such a declaration.
 */
function detectorKnows(detector: Detector, language: string): boolean {
  detectorLanguages ??= new Set(Object.values(detector.info().Languages));
  return detectorLanguages.has(language);
}

/** How much prose a body carries, after the non-language parts are removed. */
interface ProseMeasure {
  letters: number;
  words: number;
}

/** Scripts written without spaces: each character counts as a word. */
const SPACELESS_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/gu;

function measureProse(text: string): ProseMeasure {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const spaceless = text.match(SPACELESS_SCRIPT)?.length ?? 0;
  const spacedWords = text
    .split(/\s+/)
    .filter(
      (token) => /\p{L}/u.test(token) && !new RegExp(SPACELESS_SCRIPT.source, 'u').test(token),
    ).length;
  return { letters, words: spacedWords + spaceless };
}

/**
 * The language the detector names when it is strong enough to OVERRULE
 * `carried` (see {@link LANGUAGE_DETECTION.overruleMinLetters}), else
 * `undefined`.
 */
function overrulingLanguage(
  detector: Detector,
  text: string,
  prose: ProseMeasure,
  carried: string,
): string | undefined {
  if (
    prose.letters < LANGUAGE_DETECTION.overruleMinLetters ||
    prose.words < LANGUAGE_DETECTION.overruleMinWords ||
    !detectorKnows(detector, carried)
  ) {
    return undefined;
  }
  const result = detector.detect(text);
  const language = normalizeProvidedLanguage(result.language);
  if (!language || language === carried || !result.isReliable()) return undefined;
  const scores = result.getScores();
  const [top = 0, second = 0] = Object.values(scores).sort((a, b) => b - a);
  const carriedScore = scores[carried] ?? 0;
  if (top - second < LANGUAGE_DETECTION.overruleMinMargin) return undefined;
  if (top - carriedScore < LANGUAGE_DETECTION.overruleMinMarginOverCarried) return undefined;
  return language;
}

/** Where a post's resolved languages came from — reported, never stored. */
export type LanguageSource = 'declared' | 'detected' | 'script' | 'previous' | 'none';

interface ResolvedLanguages {
  primary: string | undefined;
  all: string[];
  source: LanguageSource;
}

/** Sentence boundaries for the per-sentence secondary-language vote. */
const SENTENCE_BOUNDARY = /[.!?¡¿…;\n]+/u;

/** Minimal post shape the classifier needs. Framework-agnostic; no ORM. */
export interface ClassifyInput {
  /** Visible post text (already plain text). */
  text?: string;
  /** Hashtags from the caller (e.g. AP `tag` array or user-provided). */
  hashtags?: string[];
  /** Explicit PRIMARY language if known (AP `language`, or native param). */
  language?: string;
  /**
   * Explicit FULL set of languages if known (e.g. AP top-level `language` plus
   * every `contentMap` key, via {@link extractApLanguages}). A multilingual set
   * is authoritative; a single declaration may be corrected when deterministic
   * detection strongly contradicts the visible body.
   */
  languages?: string[];
  /** Sensitive/NSFW flag to pass through. */
  sensitive?: boolean;
  /** Whether this post came from a federated instance. */
  isFederated?: boolean;
  /** Federated instance domain (host), when known. Feeds region + the RSS/bot-mirror signal. */
  instanceDomain?: string;
  /**
   * AP actor type of the author (`Person`/`Service`/`Application`/…), when the
   * post is federated. Feeds the deterministic bot-mirror spam signal; absent for
   * native posts (neutral).
   */
  actorType?: string;
  /** Author locale (e.g. `"es-ES"`), when known. Weak region fallback. */
  authorLocale?: string;
  /**
   * The languages the post is ALREADY classified under (a re-classification
   * of a stored post). They are carried, like a declaration: a different
   * result replaces them only on strong evidence, so a re-run with a different
   * detector cannot flip a correct label on a sentence too short to judge.
   */
  previousLanguages?: string[];
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
  /** Where {@link languages} came from. Diagnostic; not stored. */
  languageSource: LanguageSource;
  region?: string;
  hashtagsNorm: string[];
  /**
   * Candidate TREND TERMS from the post's own text — the vocabulary trending
   * counts in, stored as `postClassification.trendTerms`. Empty for a post with
   * no usable text (media-only, emoji-only), which is the honest outcome: such a
   * post is about nothing the term space can name.
   */
  trendTerms: string[];
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

/**
 * Pictographs (emoji, with their joiners and presentation selectors) and the
 * markdown emphasis/list markers a post carries. None of them is language, and
 * the detector would score them as words.
 */
const NON_LANGUAGE_SYMBOLS = /\p{Extended_Pictographic}|\u200d|\ufe0f|[*_~`•▪◦‣|]+/gu;

/**
 * The text language detection reads: the post's PROSE, via the same
 * {@link stripNonProse} trend extraction uses (links, `[mention:<id>]`
 * placeholders, handles, the `#` marker), minus pictographs and markdown
 * markers. A pasted URL is otherwise scored as words — a GitHub link alone
 * reads as Russian — and a placeholder adds the word `mention` plus an id to
 * every post that names someone.
 */
function languageEvidenceText(text: string): string {
  return stripNonProse(text)
    .replace(NON_LANGUAGE_SYMBOLS, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
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
  async classify(input: ClassifyInput): Promise<BaselineSignals> {
    const text = (input.text ?? '').trim();

    // Hashtags: reuse the single source of truth for post-hashtag normalization,
    // then collapse known variants via the alias map and dedupe again.
    const { hashtags: normalized } = normalizePostHashtags(input.text, input.hashtags);
    const hashtagsNorm = this.applyHashtagAliases(normalized);

    const {
      primary: language,
      all: languages,
      source: languageSource,
    } = await this.resolveLanguages(input, languageEvidenceText(text));
    const region = deriveRegion({
      isFederated: input.isFederated,
      instanceDomain: input.instanceDomain,
      authorLocale: input.authorLocale,
    });

    const topics = this.topicClassifier.classify({
      text: text.toLowerCase(),
      hashtagsNorm,
    });

    // Trend terms come from the ORIGINAL-case text: the extractor reads case to
    // tell an acronym (`EU`, `AI`) from a two-letter particle, which is the one
    // place capitalization carries meaning here. The canonical hashtags are
    // passed too, so a tag that never appeared in the visible body still counts.
    // The detected languages travel with the text because capitalization only
    // means "this names something" in languages that capitalize proper nouns
    // ALONE. German capitalizes every noun, so without this the rule admitted
    // the dictionary — `Tag` ("day") reached the live trending list.
    const trendTerms = extractTrendTerms({
      text: input.text,
      hashtags: hashtagsNorm,
      languages,
    });

    // Deterministic spam/quality/toxicity from the ORIGINAL-case text (caps ratio
    // needs case) and the canonical hashtag count (so the heuristics agree with
    // the rest of the classifier on what counts as a hashtag). The federated-origin
    // context feeds the low-effort/bot-mirror signals; it is inert for native
    // posts (no `actorType`/`instanceDomain`), so their scores are unchanged.
    // Lifted into the full scores shape (AI-only fields neutral) for storage.
    const scores = toClassificationScores(
      computeDeterministicScores(input.text ?? '', hashtagsNorm.length, {
        actorType: input.actorType,
        instanceDomain: input.instanceDomain,
        isFederated: input.isFederated,
      }),
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
      languageSource,
      region,
      hashtagsNorm,
      trendTerms,
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
   * 1. Declarations are evidence, never an unconditional discovery grant.
   * 2. A writing system that IS the text (kana, hangul) corrects a
   *    contradiction; Han that is the text can reject a Latin declaration
   *    without guessing Chinese versus Japanese.
   * 3. A single declaration stands unless the detector overrules it on strong
   *    evidence ({@link overrulingLanguage}). A declared Galician post stays
   *    `gl`: ELD has no Galician, so its `es` is no evidence against it.
   * 4. An undeclared body is detected when it carries enough prose.
   * 5. A post re-classified with `previousLanguages` keeps them unless the new
   *    result is backed by script evidence or overrules them on strong evidence.
   */
  private async resolveLanguages(
    input: Pick<ClassifyInput, 'language' | 'languages' | 'previousLanguages'>,
    text: string,
  ): Promise<ResolvedLanguages> {
    const resolved = await this.resolveFresh(input, text);
    const previous = this.normalizeLanguages(input.previousLanguages ?? []);
    if (previous.length === 0 || resolved.primary === previous[0]) return resolved;
    if (resolved.source === 'script') return resolved;
    if (resolved.primary !== undefined) {
      const detector = await languageDetector();
      if (
        overrulingLanguage(detector, text, measureProse(text), previous[0]) === resolved.primary
      ) {
        return resolved;
      }
    }
    return { primary: previous[0], all: previous, source: 'previous' };
  }

  /** {@link resolveLanguages} without the previous classification. */
  private async resolveFresh(
    input: Pick<ClassifyInput, 'language' | 'languages'>,
    text: string,
  ): Promise<ResolvedLanguages> {
    const declared = this.normalizeLanguages([input.language, ...(input.languages ?? [])]);
    const prose = measureProse(text);
    const fillable =
      prose.letters >= LANGUAGE_DETECTION.fillMinLetters &&
      prose.words >= LANGUAGE_DETECTION.fillMinWords;
    const scripted = this.strongScriptLanguage(text);
    const none: ResolvedLanguages = { primary: undefined, all: [], source: 'none' };

    if (declared.length > 1) {
      if (scripted) return { primary: scripted, all: [scripted], source: 'script' };
      const detected = fillable ? this.selectDetectedLanguages(await languageDetector(), text) : [];
      const verified = detected.filter((code) => declared.includes(code));
      return verified.length > 0
        ? { primary: verified[0], all: verified, source: 'declared' }
        : none;
    }

    if (declared.length === 1) {
      if (scripted && scripted !== declared[0]) {
        return { primary: scripted, all: [scripted], source: 'script' };
      }
      // Han is shared by Chinese and Japanese, so it cannot choose between them;
      // when it IS the text it can still prove that a Latin-only declaration
      // such as `en` is false.
      if (this.hanIsTheText(text) && !['zh', 'ja'].includes(declared[0])) return none;
      const detector = await languageDetector();
      if (overrulingLanguage(detector, text, prose, declared[0])) {
        const all = this.selectDetectedLanguages(detector, text);
        if (all.length > 0) return { primary: all[0], all, source: 'detected' };
      }
      return { primary: declared[0], all: declared, source: 'declared' };
    }

    if (scripted) return { primary: scripted, all: [scripted], source: 'script' };
    if (!fillable) return none;
    const detected = this.selectDetectedLanguages(await languageDetector(), text);
    return detected.length > 0 ? { primary: detected[0], all: detected, source: 'detected' } : none;
  }

  /** Normalize, dedupe (first-seen order) and cap a list of language tags. */
  private normalizeLanguages(tags: readonly (string | undefined)[]): string[] {
    return this.dedupeLanguages(
      tags.map(normalizeProvidedLanguage).filter((code): code is string => code !== undefined),
    ).slice(0, LANGUAGE_DETECTION.maxLanguages);
  }

  /**
   * The body's languages, primary first: the whole text's confident language,
   * plus any other language its sentences are confidently written in, holding
   * at least {@link LANGUAGE_DETECTION.secondaryMinShare} of the detectable
   * text. A body the detector is unsure about as a whole is still bilingual
   * when two languages each hold that share sentence by sentence; otherwise it
   * is unknown (`[]`).
   */
  private selectDetectedLanguages(detector: Detector, trimmedText: string): string[] {
    const whole = detectConfident(detector, trimmedText);

    const lengthByLanguage = new Map<string, number>();
    let segmentTotal = 0;
    for (const raw of trimmedText.split(SENTENCE_BOUNDARY)) {
      const segment = raw.trim();
      if (segment.length < LANGUAGE_DETECTION.minSegmentLength) continue;
      segmentTotal += segment.length;
      const detected = detectConfident(detector, segment);
      if (detected) {
        lengthByLanguage.set(
          detected.language,
          (lengthByLanguage.get(detected.language) ?? 0) + segment.length,
        );
      }
    }
    const sharedLanguages = [...lengthByLanguage.entries()]
      .filter(([, length]) => length / segmentTotal >= LANGUAGE_DETECTION.secondaryMinShare)
      .sort((a, b) => b[1] - a[1])
      .map(([language]) => language);

    const primary =
      whole?.language ?? (sharedLanguages.length > 1 ? sharedLanguages[0] : undefined);
    if (!primary) return [];
    return this.dedupeLanguages([primary, ...sharedLanguages]).slice(
      0,
      LANGUAGE_DETECTION.maxLanguages,
    );
  }

  /**
   * Languages whose writing system is decisive without a vocabulary model —
   * when that writing system is the text ({@link LANGUAGE_DETECTION.scriptMinShare}),
   * not a word quoted inside another language.
   */
  private strongScriptLanguage(text: string): string | undefined {
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    if (letters === 0) return undefined;
    const share = (pattern: RegExp): number => (text.match(pattern)?.length ?? 0) / letters;
    const kana = share(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
    if (kana > 0 && kana + share(/\p{Script=Han}/gu) >= LANGUAGE_DETECTION.scriptMinShare) {
      return 'ja';
    }
    if (share(/\p{Script=Hangul}/gu) >= LANGUAGE_DETECTION.scriptMinShare) return 'ko';
    return undefined;
  }

  /** Han characters are at least {@link LANGUAGE_DETECTION.scriptMinShare} of the letters. */
  private hanIsTheText(text: string): boolean {
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
    return letters > 0 && han / letters >= LANGUAGE_DETECTION.scriptMinShare;
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
    const aliased = hashtags.map(canonicalHashtag);
    return [...new Set(aliased)];
  }
}

/** Default singleton (rule-based topics). */
export const baselineContentClassifier = new BaselineContentClassifier();
