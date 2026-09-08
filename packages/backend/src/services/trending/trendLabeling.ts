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
 *  - **A name is used in full when the posts write it in full.** The term is
 *    whatever people type — `trump` — and the row should say `Donald Trump`.
 *    That is not a claim about the story, so it is not held to the majority a
 *    defining phrase is; it is held to being unambiguous instead.
 */

import { MtnConfig, normalizeTrendCategory } from '@mention/shared-types';
import type { TrendCategory } from '@mention/shared-types';
import { ruleBasedTopicClassifier } from '../contentClassification/TopicClassifier';
import { canonicalHashtag } from '../contentClassification/taxonomy';
import { collectTrendPhraseEntries, stripNonProse, type TrendPhrase } from './termExtraction';

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
 * v6: a phrase may name the trend when it is the SUBJECT'S OWN NAME WRITTEN
 * OUT — every word capitalized as a name, the term among them as a whole word,
 * and nothing naming on either side of it. That question is not the one a
 * defining phrase answers, so it does not need a majority: plenty of posts about
 * Donald Trump just say Trump, which is what a short name is FOR, and the
 * majority bar therefore answered `Trump` forever. It needs agreement (a quarter
 * of the posts) and it needs to be unambiguous (twice the runner-up), because
 * `John Smith` and `Jane Smith` in one trend on `smith` is a coin flip, and a
 * coin flip presented as a name is worse than the name people typed.
 *
 * Also in v6: "the phrase restates the term" is a WORD test now, not a substring
 * test. `us` sits inside `justice`, `russia` and `industry`, so a trend on the
 * acronym discarded nearly every phrase it could have been named after before
 * counting it.
 *
 * v5: the surface form is read from PROSE, with links removed, so a term
 * appearing lower-case inside a URL cannot outvote the way people write it.
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
export const TREND_LABEL_VERSION = 6;

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

/**
 * Longest label. Beyond this it is a sentence, not a name.
 *
 * Two tokens of up to `maxTokenLength` make a 65-character expansion reachable,
 * so this can fire on one. It degrades to `titleCase(term)` — the TERM, not a
 * truncated subject — which is the right answer: a name too long to print is
 * better dropped than cut mid-word.
 */
const MAX_DISPLAY_NAME_LENGTH = 48;

/**
 * Share of the sampled posts that must write the full name before the label is
 * expanded to it.
 *
 * Deliberately NOT the majority {@link PHRASE_MIN_COVERAGE} demands, and the
 * difference is the point. A defining phrase makes a claim about the STORY —
 * "these posts are about Dean Kremer" — and a wrong claim there renames the
 * trend after one strand of it, so it has to be carried by most of the room. An
 * expansion makes no claim about the story at all: it says the thing already
 * being named has a longer name, and every post that wrote `Trump` is silently
 * agreeing rather than disagreeing. Plenty of posts about Donald Trump just say
 * Trump — that is what a short name is FOR — so a majority bar would answer
 * "Trump" for the exact case this exists to fix.
 */
const NAME_EXPANSION_MIN_COVERAGE = 0.25;

/** …and never fewer than this many posts, whatever the share works out to. */
const NAME_EXPANSION_MIN_POSTS = 2;

/**
 * How far ahead of the runner-up an expansion must be.
 *
 * The bar above says "confident"; this one says "UNAMBIGUOUS", and they are not
 * the same test. For a trend on `smith`, three posts writing `John Smith` and
 * two writing `Jane Smith` clear any coverage bar low enough to be useful, and
 * naming the row after either one is a coin flip presented as a fact. Twice the
 * runner-up or the term stays as it is — a shorter true name always beats a
 * longer maybe.
 */
const NAME_EXPANSION_DOMINANCE = 2;

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

  // ONE tokenization, read by both questions below. Two passes would be two
  // chances for them to disagree about what a phrase is — the mistake that
  // shipped `Nba`, recorded in `stripNonProse`.
  const phrasesByPost = excerpts.map((excerpt) => collectTrendPhraseEntries(excerpt));

  // What is the STORY: a phrase most posts share that is not the term restated.
  const phrase = findDefiningPhrase(term, phrasesByPost);
  const subject = phrase ?? term;
  // …and then the other question: is the subject the short form of a name the
  // posts write out in full? `trump` is the term people type; `Donald Trump` is
  // what the row should say.
  //
  // The story comes FIRST and that order is load-bearing. If posts on `orioles`
  // say both `Baltimore Orioles` (4 of 12) and `Dean Kremer` (7 of 12), the
  // story is Dean Kremer, and a majority beats a quarter.
  const named = findNameExpansion(subject, phrasesByPost) ?? subject;
  const name = presentableSurfaceForm(named, excerpts) ?? titleCase(named);

  return {
    displayName: name.length > MAX_DISPLAY_NAME_LENGTH ? titleCase(term) : name,
    category: deriveCategory(term, excerpts),
  };
}

/**
 * Whether `term` appears as a whole WORD (or run of words) of `phrase`.
 *
 * The substring test this replaces rejected the right things for the wrong
 * reason. `orioles trade` was meant to be rejected because it restates the term;
 * `trumpet lessons` was rejected because `trump` happens to be five of its
 * letters, and for a short acronym the damage is total — `us` sits inside
 * `justice`, `russia` and `industry`, so almost every phrase a trend on `US`
 * could have been named after was thrown away before it was counted.
 *
 * Both sides come out of the same tokenizer as space-joined lowercase words, so
 * this is a word-sequence scan and not a text search — no regex, nothing to
 * escape.
 */
function phraseContainsTerm(phrase: string, term: string): boolean {
  const phraseWords = phrase.split(' ');
  const termWords = term.split(' ');
  if (termWords.length > phraseWords.length) return false;
  for (let start = 0; start + termWords.length <= phraseWords.length; start++) {
    if (termWords.every((word, offset) => phraseWords[start + offset] === word)) return true;
  }
  return false;
}

/**
 * The full name the posts write out, when the subject is a shortened form of one.
 *
 * A candidate is a phrase that (1) contains the subject as a whole word, (2) has
 * every one of its words NAMING something, and (3) stood alone — no naming token
 * on either side of it. Those three are the whole rule:
 *
 *  - Containment is what makes it an expansion rather than a different subject.
 *  - EVERY word naming is what separates `Donald Trump` from `Orioles trade`.
 *    It is also a strictly better version of the test the old substring
 *    rejection was reaching for: `trade` is not capitalized mid-sentence, so
 *    `orioles trade` now fails on the evidence rather than on its spelling.
 *  - Standing alone is what stops a two-word window onto a longer name being
 *    reported as the name. `maxPhraseTokens` is 2, so "Martin Luther King" is
 *    never emitted whole; without this flag a trend on `king` would ship as
 *    "Luther King", and one on `yankees` as "York Yankees". Both are worse than
 *    the bare term. What remains is an honest limitation rather than a wrong
 *    answer: a three-word name is not recovered, and the label stays the term.
 *
 * Coverage is counted once per post for free — the tokenizer already dedupes
 * within a post, so a post shouting a name ten times contributes one.
 */
function findNameExpansion(
  subject: string,
  phrasesByPost: readonly (readonly TrendPhrase[])[],
): string | null {
  const subjectWords = subject.split(' ').length;
  const coverage = new Map<string, number>();

  for (const phrases of phrasesByPost) {
    for (const phrase of phrases) {
      if (phrase.names.length <= subjectWords) continue; // must ADD a word
      if (!phrase.whole) continue;
      if (!phrase.names.every(Boolean)) continue;
      if (!phraseContainsTerm(phrase.text, subject)) continue;
      coverage.set(phrase.text, (coverage.get(phrase.text) ?? 0) + 1);
    }
  }

  // Materialised and sorted rather than scanned out of the Map: insertion order
  // follows whichever post the database returned first, and a batch has to be a
  // pure function of its input. Ties break on the phrase, for the same reason.
  const ranked = [...coverage.entries()].sort(
    ([leftText, left], [rightText, right]) => right - left || (leftText < rightText ? -1 : 1),
  );
  if (ranked.length === 0) return null;

  const [text, count] = ranked[0];
  const runnerUp = ranked[1]?.[1] ?? 0;

  const minPosts = Math.max(
    NAME_EXPANSION_MIN_POSTS,
    Math.ceil(phrasesByPost.length * NAME_EXPANSION_MIN_COVERAGE),
  );
  if (count < minPosts) return null;
  // `n < 2n` for every n >= 1, so an exact tie is unwinnable by construction and
  // the lexicographic tie-break above can never decide a LABEL — it only makes
  // "which one is first" deterministic, which is what this comparison needs.
  if (count < runnerUp * NAME_EXPANSION_DOMINANCE) return null;

  return text;
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
 * the term (`orioles trade`) adds a word without adding a subject. A phrase that
 * is the term's own fuller NAME is rejected here too, and picked up instead by
 * {@link findNameExpansion}, which asks a different question at a different bar.
 */
function findDefiningPhrase(
  term: string,
  phrasesByPost: readonly (readonly TrendPhrase[])[],
): string | null {
  const coverage = new Map<string, number>();

  for (const phrases of phrasesByPost) {
    for (const phrase of phrases) {
      // Multi-word only: a single co-occurring word is far too weak a signal to
      // rename a trend after (`trade`, `source`, `season`).
      if (phrase.names.length < 2) continue;
      if (phraseContainsTerm(phrase.text, term)) continue;
      coverage.set(phrase.text, (coverage.get(phrase.text) ?? 0) + 1);
    }
  }

  const minPosts = Math.max(PHRASE_MIN_POSTS, Math.ceil(phrasesByPost.length * PHRASE_MIN_COVERAGE));

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
    // PROSE only, the same text extraction reads. A link is not a spelling
    // anybody chose: ten bot posts pointing at `rawchili.com/nba/…` made the
    // commonest form of `NBA` a lower-case one, and a term nobody appears to
    // capitalize falls through to title case — `Nba`.
    for (const match of stripNonProse(excerpt).matchAll(pattern)) {
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
