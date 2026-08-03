/**
 * Trend labelling — turning a detected term into something a reader recognises.
 *
 * A term is a RETRIEVAL key: it has to match the words people typed, so it is
 * lowercase, often a fragment, and sometimes not even the subject (`orioles`
 * for a trade involving a pitcher named Kremer). A LABEL is what the story is.
 * They are different strings on purpose, and conflating them is what makes a
 * trending list read like a log of tokens.
 *
 * ## No model runs here
 *
 * This is entirely deterministic — no network, no key, no spend — and it runs on
 * every trend of every batch. That is a deliberate reversal: an earlier version
 * asked a model to name each new trend, which meant paying for a generation
 * every time a term crossed the threshold, forever, whether or not a single
 * reader ever looked at it. Generated prose now happens ON DEMAND and only for
 * trends people actually open (see {@link ./trendSummary}).
 *
 * The two rules below are worth stating because they are what makes a
 * deterministic label good enough to be the default:
 *
 *  - **Casing comes from the corpus, not from a rule.** The stored term is
 *    lowercase, so title-casing it yields `Fifa`. Reading back the surface form
 *    people actually typed yields `FIFA` — and `FrightClub`, and `iPhone`.
 *    Nothing needs to know what an acronym is.
 *  - **A shared phrase beats the term.** When most posts about `orioles` say
 *    `Dean Kremer`, that phrase is what the story is, and it is a phrase people
 *    genuinely wrote rather than a summary of them. The term stays the key; the
 *    phrase becomes the name.
 */

import { MtnConfig, normalizeTrendCategory } from '@mention/shared-types';
import type { TrendCategory } from '@mention/shared-types';
import { ruleBasedTopicClassifier } from '../contentClassification/TopicClassifier';
import { canonicalHashtag } from '../contentClassification/taxonomy';
import { collectTrendPhrases } from './termExtraction';

/**
 * Version of the labelling rules.
 *
 * Stored beside every label so a run can tell a label THESE rules produced from
 * one an older build left behind. Without it, a label is reused for the life of
 * a run — which is the right default, since renaming a live story mid-scroll is
 * a bug — and a rules fix therefore does not reach any trend already running.
 * That is not hypothetical: `POLITICS` stayed on the live list after the fix
 * that would have written `Politics`, because its run had started first.
 *
 * Bump whenever a change would produce a different LABEL for the same posts —
 * the displayed name or the category, since both are stored here and both are
 * shown.
 *
 * v2: a corpus spelling is preferred only when it adds capitalization and is
 * not shouted (see {@link presentableSurfaceForm}).
 *
 * v4: a topic must be supported by a minimum SHARE of the posts read before it
 * becomes the category; below that the row reports `other`. One post in twelve
 * saying "climate change" was enough to file `US` under Science.
 *
 * v3: the category is the topic the most posts support, rather than the first
 * slug the classifier returns — which was its rule array's line order. Missing
 * this bump reproduced the incident described above one release later: `US`
 * stayed filed under Science after the fix that would have written `other`,
 * because its run had started first and its label was reused verbatim.
 */
export const TREND_LABEL_VERSION = 4;

/** What a trend is shown as. */
export interface TrendLabel {
  /** Human-readable name — the only string a reader sees. */
  displayName: string;
  /** Coarse taxonomy hint, `other` when nothing fits. */
  category: TrendCategory;
}

/** A term plus the posts that carry it — everything labelling reads. */
export interface TrendLabelInput {
  term: string;
  /** Sample post texts, ORIGINAL case (the casing is half the signal). */
  excerpts: readonly string[];
}

/**
 * Share of the sampled posts a phrase must appear in before it may replace the
 * term as the label.
 *
 * A majority, deliberately. Below it, a phrase describes one strand of the
 * conversation rather than the story, and naming the whole trend after it would
 * be worse than the plain term — a reader cannot tell a confident label from a
 * lucky one, so the bar has to be where a wrong answer is rare.
 */
const PHRASE_MIN_COVERAGE = 0.5;

/** A phrase must also appear in at least this many posts, whatever the share. */
const PHRASE_MIN_POSTS = 2;

/** Longest label. Beyond this it is a sentence, not a name. */
const MAX_DISPLAY_NAME_LENGTH = 48;

/**
 * Rule-topic slug → trend category.
 *
 * The rule classifier's vocabulary is 21 slugs tuned for ranking; a category is
 * a one-word hint under a headline. Several slugs therefore collapse onto one
 * category, and a few honestly map to nothing — `business`, `finance` and
 * `lgbtq` are absent on purpose rather than forced into a bucket that would
 * misdescribe them, and they degrade to `other` (which renders as no category
 * at all, not as the word "Other").
 */
const TOPIC_SLUG_TO_CATEGORY: Readonly<Record<string, TrendCategory>> = {
  news: 'news',
  politics: 'politics',
  sports: 'sports',
  gaming: 'video-games',
  tech: 'tech',
  ai: 'tech',
  science: 'science',
  health: 'science',
  education: 'science',
  entertainment: 'pop-culture',
  music: 'pop-culture',
  memes: 'pop-culture',
  art: 'pop-culture',
  design: 'pop-culture',
  photography: 'pop-culture',
  fashion: 'pop-culture',
  food: 'pop-culture',
  travel: 'pop-culture',
};

/**
 * The label for a term with no evidence behind it: the term, title-cased.
 *
 * Reached when the excerpt lookup failed or returned nothing. Deliberately dull
 * — a fabricated name would be indistinguishable downstream from a real one.
 */
export function fallbackTrendLabel(term: string): TrendLabel {
  return { displayName: titleCase(term), category: 'other' };
}

/**
 * Derive a trend's label and category from the posts behind it.
 *
 * Pure and total: always answers, never throws, never calls anything.
 */
export function deriveTrendLabel(input: TrendLabelInput): TrendLabel {
  const term = input.term.trim().toLowerCase();
  if (!term) return fallbackTrendLabel(input.term);

  const excerpts = input.excerpts.filter((excerpt) => excerpt.trim().length > 0);
  if (excerpts.length === 0) return fallbackTrendLabel(term);

  const phrase = findDefiningPhrase(term, excerpts);
  const subject = phrase ?? term;
  const name = presentableSurfaceForm(subject, excerpts) ?? titleCase(subject);

  return {
    displayName: name.length > MAX_DISPLAY_NAME_LENGTH ? titleCase(term) : name,
    category: deriveCategory(term, excerpts),
  };
}

/**
 * The phrase most of the posts share, when there is one.
 *
 * Counts each phrase ONCE PER POST (coverage), never per occurrence: a single
 * post repeating a name ten times would otherwise outvote ten posts that agree,
 * which is the same "posts are not people" mistake the author floor exists to
 * prevent one level up.
 *
 * A phrase that merely restates the term is rejected — `orioles` naming itself
 * `Orioles` is what the surface-form step already does, and a phrase containing
 * the term (`orioles trade`) adds a word without adding a subject.
 */
function findDefiningPhrase(term: string, excerpts: readonly string[]): string | null {
  const coverage = new Map<string, number>();

  for (const excerpt of excerpts) {
    for (const phrase of collectTrendPhrases(excerpt)) {
      // Multi-word only: a single co-occurring word is far too weak a signal to
      // rename a trend after (`trade`, `source`, `season`).
      if (!phrase.includes(' ')) continue;
      if (phrase === term || phrase.includes(term)) continue;
      coverage.set(phrase, (coverage.get(phrase) ?? 0) + 1);
    }
  }

  const minPosts = Math.max(PHRASE_MIN_POSTS, Math.ceil(excerpts.length * PHRASE_MIN_COVERAGE));

  let best: string | null = null;
  let bestCount = 0;
  for (const [phrase, count] of coverage) {
    if (count < minPosts) continue;
    // Ties break on the phrase itself so a batch is a pure function of its
    // input — never on Map insertion order, which follows whichever post the
    // database happened to return first.
    if (count > bestCount || (count === bestCount && best !== null && phrase < best)) {
      best = phrase;
      bestCount = count;
    }
  }

  return best;
}

/**
 * The corpus spelling of a phrase, but only when it is worth preferring over
 * title case.
 *
 * Reading casing back from the corpus is what recovers `FIFA` and `FrightClub`
 * without anything knowing what an acronym is. Shipped unfiltered, though, it
 * also faithfully reproduces two things nobody wants to read — both observed on
 * the first live batch:
 *
 *  - `POLITICS`, because the word's most common appearance is inside a shouted
 *    hashtag tail. A label is a headline, not a transcription of the loudest
 *    poster.
 *  - `mention`, because the word is usually written mid-sentence in lower case,
 *    so the corpus form carries no capitalization to prefer at all.
 *
 * So a surface form is used only when it says something title case cannot: it
 * contains a capital, and it is not simply SHOUTED. An all-caps form survives
 * only while it is short enough to plausibly be an acronym — a crude test, but
 * one that separates `FIFA`, `NASA` and `UNESCO` from `POLITICS` and `NOTICIAS`
 * without a dictionary, and its failure mode is a correctly-capitalised word.
 */
function presentableSurfaceForm(phrase: string, excerpts: readonly string[]): string | null {
  const surface = surfaceForm(phrase, excerpts);
  if (!surface) return null;

  const letters = surface.replace(/[^\p{L}]/gu, '');
  if (!letters) return null;
  // No capital anywhere: title case is strictly more presentable.
  if (letters === letters.toLowerCase()) return null;
  // Shouted, and too long to be an acronym.
  if (letters === letters.toUpperCase() && letters.length > ACRONYM_MAX_LENGTH) return null;

  return surface;
}

/** Longest all-caps form still treated as an acronym rather than shouting. */
const ACRONYM_MAX_LENGTH = 6;

/**
 * The most frequent way this phrase is spelled across the posts.
 *
 * Returns `null` when the phrase never appears verbatim — which happens for a
 * term that only ever arrived through a caller-supplied hashtag array, never in
 * a visible body.
 */
function surfaceForm(phrase: string, excerpts: readonly string[]): string | null {
  // Word-boundary match on the phrase, tolerating the `#` marker and any run of
  // whitespace between its words — the same text the tokenizer read, before it
  // lowercased anything.
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])#?${phrase.split(' ').map(escapeRegExp).join('\\s+')}(?![\\p{L}\\p{N}])`,
    'giu',
  );

  const counts = new Map<string, number>();
  for (const excerpt of excerpts) {
    for (const match of excerpt.matchAll(pattern)) {
      const surface = match[0].replace(/^#/, '').replace(/\s+/g, ' ');
      counts.set(surface, (counts.get(surface) ?? 0) + 1);
    }
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [surface, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && surface < best)) {
      best = surface;
      bestCount = count;
    }
  }

  return best;
}

/**
 * Categorise the trend with the SAME rule classifier every post already runs
 * through at ingest.
 *
 * Reusing it rather than adding a second classifier means a trend and the posts
 * inside it can never disagree about what they are about, and the taxonomy has
 * exactly one place to evolve.
 */
function deriveCategory(term: string, excerpts: readonly string[]): TrendCategory {
  // The TERM's own mapping wins outright when it has one. It is the single most
  // on-topic token available — a trend on `esports` should not be categorised
  // from the prose around it — and it is evidence about the subject rather than
  // about whatever else its posts happened to mention.
  // Canonicalized first, exactly as ingest does. `HASHTAG_TOPIC_MAP` keys on
  // canonical slugs alone, so the raw term matched only when it already WAS one
  // — and those are refused as candidates now, which left this branch
  // unreachable. Through the alias it answers for `climate`, `spotify` and
  // every other variant a person actually types.
  const fromTerm = ruleBasedTopicClassifier.classify({
    text: '',
    hashtagsNorm: [canonicalHashtag(term)],
  });
  for (const slug of fromTerm) {
    const category = TOPIC_SLUG_TO_CATEGORY[slug];
    if (category) return normalizeTrendCategory(category);
  }

  // Otherwise the topic the most POSTS support, not the first the classifier
  // happens to return. `classify` emits slugs in the order its rule array is
  // written, so taking the first made file order the tiebreak: `Trump` was
  // filed under Science because one post said "climate change" and the science
  // rule sits two lines above the politics rule. Counting posts asks the
  // question the row actually poses — what are these mostly about.
  const support = new Map<string, number>();
  for (const excerpt of excerpts) {
    for (const slug of ruleBasedTopicClassifier.classify({
      text: excerpt.toLowerCase(),
      hashtagsNorm: [],
    })) {
      support.set(slug, (support.get(slug) ?? 0) + 1);
    }
  }

  // Weak evidence has to read like no evidence: one mention among a dozen posts
  // is not what a row is about.
  const { minCategorySupport, minCategorySupportPosts } = MtnConfig.trending.labeling;
  const required = Math.max(
    minCategorySupportPosts,
    Math.ceil(excerpts.length * minCategorySupport),
  );

  const ranked = [...support.entries()]
    .filter(([, count]) => count >= required)
    .sort(
    // Ties break by slug so two batches over identical posts agree.
    ([leftSlug, left], [rightSlug, right]) => right - left || leftSlug.localeCompare(rightSlug),
  );
  for (const [slug] of ranked) {
    const category = TOPIC_SLUG_TO_CATEGORY[slug];
    if (category) return normalizeTrendCategory(category);
  }
  return 'other';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Title-case a phrase for display (`todd blanche` → `Todd Blanche`).
 *
 * The last resort, used only when the phrase never appeared in any post body.
 * Word-by-word and nothing else: no small-word rules, no acronym repair. The
 * input is already lowercase, so `EU` cannot be recovered — and a rule that
 * guessed would be wrong on exactly the terms it was written for.
 */
function titleCase(term: string): string {
  return term
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}
