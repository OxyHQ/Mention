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

import { normalizeTrendCategory } from '@mention/shared-types';
import type { TrendCategory } from '@mention/shared-types';
import { ruleBasedTopicClassifier } from '../contentClassification/TopicClassifier';
import { collectTrendPhrases } from './termExtraction';

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
  const name = surfaceForm(phrase ?? term, excerpts) ?? titleCase(phrase ?? term);

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
 * How people actually spell this phrase, taken from the posts themselves.
 *
 * The most frequent surface form wins, so `FIFA` beats `fifa` when four posts
 * shout it and one does not. Returns `null` when the phrase never appears
 * verbatim — which happens for a term that only ever arrived through a
 * caller-supplied hashtag array, never in a visible body.
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
  const slugs = ruleBasedTopicClassifier.classify({
    text: excerpts.join(' \n ').toLowerCase(),
    // The TERM is passed as a hashtag because that is what it is: a normalized,
    // `#`-stripped token, the exact shape the classifier's hashtag rules key on.
    // Withholding it would throw away the single most on-topic token available —
    // a trend on `esports` would be classified purely from the prose around it.
    hashtagsNorm: [term],
  });

  for (const slug of slugs) {
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
