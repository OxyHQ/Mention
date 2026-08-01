/**
 * Trend-term extraction — what a post contributes to the trending vocabulary.
 *
 * Pure and synchronous: no DB, no network, no clock. It runs inside the Stage-A
 * {@link BaselineContentClassifier} on EVERY post (native and federated) at
 * ingest, so its cost is paid once per post rather than once per batch over a
 * day of posts.
 *
 * The one idea worth stating plainly: **a hashtag is not a special kind of
 * thing**. `#FIFA`, `#fifa` and a bare `FIFA` in a sentence all reduce to the
 * term `fifa`, and from there they are counted together. Trending used to have a
 * hashtag lane and a topic lane, which meant a story only registered if someone
 * typed a `#` — and the lane that was easiest to fill was the one that filled up.
 * Measuring words instead is what lets a burst be detected from prose.
 *
 * What comes out is CANDIDATES, not trends. This step is deliberately generous
 * and cheap; deciding which candidates are actually bursting is
 * {@link ./trendScoring}'s job, and it has the whole corpus to compare against
 * whereas this has one post.
 */

import { MtnConfig } from '@mention/shared-types';
import { stripMentionPlaceholders } from '@mention/shared-types/mentions';

/**
 * Function words dropped before phrases are built, unioned across the languages
 * Mention actually carries (en/es/it/pt/fr/de).
 *
 * A UNION rather than a per-language list on purpose: terms live in one shared
 * space (that is the point of the previous paragraph), a post can be bilingual,
 * and language detection is a separate signal that can be absent entirely. The
 * cost of the union is that a word which is a function word in one language and
 * a content word in another is lost for both — checked, and the overlap is words
 * like `come`/`son`/`van` that no one would recognise as a trend on their own.
 *
 * Deliberately NOT shared with `GIF_STOPWORDS` (gifLibrary). That set exists to
 * strip noise from a MongoDB text query on a `default_language: 'none'` index —
 * twenty-odd tokens tuned for search recall. This one exists to keep phrases
 * from gluing across function words. Same technique, different jobs; fusing them
 * would tie the trending vocabulary to a search-index detail.
 */
export const TREND_TERM_STOPWORDS: ReadonlySet<string> = new Set([
  // English
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how',
  'its', 'new', 'now', 'old', 'see', 'two', 'who', 'boy', 'did', 'she', 'use',
  'way', 'from', 'they', 'this', 'that', 'with', 'have', 'been', 'were', 'what',
  'when', 'your', 'said', 'each', 'them', 'then', 'than', 'some', 'very', 'just',
  'into', 'only', 'over', 'also', 'back', 'because', 'about', 'after', 'again',
  'their', 'there', 'these', 'those', 'would', 'could', 'should', 'still',
  'being', 'doing', 'going', 'really', 'like', 'dont', 'cant', 'wont', 'thats',
  'here', 'much', 'more', 'most', 'even', 'well', 'want', 'need', 'make', 'made',
  'know', 'think', 'people', 'time', 'good', 'today', 'yeah', 'okay', 'https',
  'http', 'www', 'com',
  // Question words, modals and auxiliaries. Closed-class: a language gains new
  // nouns constantly and new modals almost never, so these can be listed
  // exhaustively and will never accidentally exclude a subject. `why` and
  // `will` both reached the live trending list before this line existed.
  'why', 'whom', 'whose', 'which', 'will', 'shall', 'must', 'might', 'may',
  'does', 'doing', 'done', 'didnt', 'doesnt', 'isnt', 'arent', 'wasnt',
  'werent', 'hasnt', 'havent', 'couldnt', 'wouldnt', 'shouldnt', 'youre',
  'theyre', 'weve', 'youve', 'theyve', 'ill', 'ive', 'youll', 'theyll',
  'mine', 'yours', 'ours', 'theirs', 'himself', 'herself', 'itself',
  'myself', 'yourself', 'themselves', 'anyone', 'someone', 'everyone',
  'nobody', 'anything', 'everything', 'nothing', 'somewhere', 'anywhere',
  'everywhere',
  // Spanish
  'que', 'los', 'las', 'del', 'por', 'con', 'una', 'uno', 'para', 'como', 'pero',
  'sus', 'les', 'más', 'mas', 'este', 'esta', 'esto', 'esos', 'esas', 'ese',
  'eso', 'hay', 'son', 'ser', 'está', 'esta', 'están', 'estan', 'muy', 'todo',
  'toda', 'todos', 'todas', 'porque', 'cuando', 'donde', 'desde', 'hasta',
  'sobre', 'entre', 'tiene', 'tienen', 'hace', 'hacer', 'puede', 'ahora',
  'siempre', 'nunca', 'también', 'tambien', 'aunque', 'nada', 'algo', 'otro',
  'otra', 'gente', 'año', 'años', 'día', 'días', 'vez', 'ver',
  // Italian
  'che', 'non', 'per', 'con', 'una', 'del', 'della', 'dei', 'delle', 'sono',
  'come', 'più', 'piu', 'anche', 'questo', 'questa', 'quando', 'perché',
  'perche', 'essere', 'fare', 'molto', 'tutto', 'tutti', 'solo', 'dopo',
  // Portuguese
  'não', 'nao', 'uma', 'você', 'voce', 'pela', 'pelo', 'isso', 'mais', 'mesmo',
  'ainda', 'quem', 'onde', 'está', 'estão', 'estao', 'fazer', 'muito',
  // French
  'les', 'des', 'une', 'est', 'pas', 'pour', 'que', 'qui', 'dans', 'sur', 'avec',
  'sont', 'plus', 'mais', 'tout', 'tous', 'être', 'etre', 'cette', 'nous',
  'vous', 'leur', 'même', 'meme', 'faire', 'comme',
  // German
  'der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'auf',
  'für', 'fur', 'von', 'dem', 'den', 'des', 'auch', 'sich', 'aber', 'wie',
  'noch', 'nur', 'schon', 'sind', 'wird', 'werden', 'haben', 'kann',
  // German pronouns, modals and particles. The list was English-heavy, and a
  // live batch showed what that costs: `ich`, `danke` and `dir` were reported
  // as trends, and a dump of stored terms was thick with `wenn`, `jetzt`,
  // `bitte` and `könnte`. Closed-class in German exactly as in English, so
  // naming them all is safe.
  'ich', 'mich', 'mir', 'dich', 'dir', 'ihm', 'ihn', 'ihnen', 'uns', 'euch',
  'wir', 'ihr', 'sie', 'wenn', 'dann', 'jetzt', 'immer', 'wieder', 'sehr',
  'mehr', 'viel', 'ganz', 'etwas', 'nichts', 'alles', 'jede', 'jeder', 'kein',
  'keine', 'könnte', 'konnte', 'muss', 'müssen', 'mussen', 'soll', 'sollte',
  'will', 'wollen', 'darf', 'dürfen', 'durfen', 'mag', 'möchte', 'mochte',
  'hat', 'hatte', 'habe', 'war', 'waren', 'wurde', 'worden', 'bin', 'bist',
  'sein', 'seine', 'ihre', 'mein', 'meine', 'dein', 'deine', 'danke', 'bitte',
  'oder', 'weil', 'dass', 'damit', 'durch', 'gegen', 'ohne', 'über', 'uber',
  'unter', 'zwischen', 'nach', 'vor', 'bei', 'zum', 'zur', 'als', 'man',
]);

/**
 * Whether a stored term is nothing but stop words.
 *
 * Applied at DETECTION as well as at extraction (see the trending batch), so a
 * term stored under an older word list cannot keep trending until the window
 * rolls past it.
 *
 * A phrase counts only when EVERY word in it is a stop word: `will` is noise,
 * `will smith` is a person, and a phrase is exactly where a stop word stops
 * being one.
 */
export function isTrendStopWord(term: string): boolean {
  const words = term.split(' ').filter((word) => word.length > 0);
  return words.length > 0 && words.every((word) => TREND_TERM_STOPWORDS.has(word));
}

/**
 * Splits text into SEGMENTS at anything that is not a letter, digit, apostrophe
 * or space. Punctuation, emoji and symbols all end a segment, which is what
 * stops a phrase from being built across a comma or a line break — `Kremer,
 * Orioles` must not become the phrase `kremer orioles`, because nobody wrote it.
 *
 * Uses Unicode property escapes, which is safe HERE and would not be in the
 * frontend: this module is backend-only (Bun), while mobile Hermes rejects
 * `\p{...}` at runtime (see `~/Oxy/AGENTS.md` § Hermes).
 */
const SEGMENT_BOUNDARY = /[^\p{L}\p{N}' ]+/u;

/** Strips URLs, @mentions and the `#` marker (keeping the tag's word). */
const URL_PATTERN = /https?:\/\/\S+|www\.\S+/gi;
const MENTION_PATTERN = /@[\p{L}\p{N}_.-]+(?:@[\p{L}\p{N}.-]+)?/gu;

/*
 * NOTE on ordering: `stripMentionPlaceholders` runs FIRST, before any pattern
 * below. A native mention is stored as `[mention:<id>]` — the display form with
 * an `@handle` only exists after hydration — so nothing here would ever see it,
 * and the tokenizer would split the placeholder into the literal word `mention`
 * plus a user id and count both as things people were talking about.
 */

/**
 * A rendered federated mention: `[Display Name](handle@instance.tld)`.
 *
 * Removed WHOLE — label and target — and this is the single most important
 * thing this module strips. A federated reply is stored in exactly this shape,
 * and neither half is a topic: the label is somebody's display name and the
 * target is their handle plus their server. Left in, every reply donated its
 * recipient to the trending vocabulary, and the terms that reached the live
 * list were other people's handles (`weedbunt`, `tergiversatrix`), their
 * display names (`ez growing colder`) and instance domains — including
 * `mention`, harvested from `@someone@mention.earth`, which is how this
 * instance's own domain came to trend on it.
 *
 * The `@` on the target is optional because the stored form omits it.
 */
const MENTION_LINK_PATTERN = /\[[^\]\n]*\]\(\s*@?[\p{L}\p{N}_.-]+@[\p{L}\p{N}.-]+\s*\)/gu;

/**
 * Any other markdown link: the LABEL is kept (it is prose the author wrote) and
 * the target is dropped, because a URL's path segments are not words anybody
 * said.
 */
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]*)\]\([^)\n]*\)/gu;

/**
 * A bare `handle@instance.tld` with no leading `@` and no markdown around it.
 *
 * The same leak by another route — a handle pasted into prose, or a mention
 * whose markdown did not survive whatever rewrote the text. Also catches email
 * addresses, which are likewise not topics.
 */
const BARE_HANDLE_PATTERN = /(?<![\p{L}\p{N}])[\p{L}\p{N}_.-]+@[\p{L}\p{N}.-]+/gu;

/** A token below the length floor survives only as an ALL-CAPS acronym. */
const MIN_ACRONYM_LENGTH = 2;

/** Input a post contributes. Framework-agnostic — no Mongoose, no Post model. */
export interface TrendTermInput {
  /** Visible post text (plain text, original case — the case carries acronyms). */
  text?: string | null;
  /** Canonical hashtags for the post (lowercase, `#`-stripped, already deduped). */
  hashtags?: readonly string[];
}

/**
 * Extract this post's candidate trend terms, in reading order, deduplicated and
 * capped at `MtnConfig.trending.terms.maxTermsPerPost`.
 *
 * Reading order matters for the cap: the subject of a post is almost always near
 * its start, so truncating the tail costs the least. Never sorted — a sort would
 * make the cap keep whichever terms happen to be alphabetically early.
 */
export function extractTrendTerms(input: TrendTermInput): string[] {
  const { minTokenLength, maxTokenLength, maxTermsPerPost } = MtnConfig.trending.terms;

  const terms: string[] = [];
  const seen = new Set<string>();

  const push = (term: string): void => {
    if (seen.has(term) || terms.length >= maxTermsPerPost) return;
    seen.add(term);
    terms.push(term);
  };

  for (const phrase of collectTrendPhrases(input.text)) push(phrase);

  // Caller-supplied hashtags last: a tag that never appeared in the visible text
  // (the composer's own tag field, or a federated `tag` array) is still a term,
  // but the body is what the post is about, so the cap protects the body first.
  for (const hashtag of input.hashtags ?? []) {
    const token = normalizeToken(hashtag);
    if (token && isKeepableToken(hashtag, token, minTokenLength, maxTokenLength)) {
      push(token);
    }
  }

  return terms;
}

/**
 * Every phrase a text yields, deduplicated and in reading order — UNCAPPED.
 *
 * Split out from {@link extractTrendTerms} because labelling needs the full set
 * rather than a post's first dozen: it counts how many posts of a trend share a
 * phrase, and a cap applied per post would silently bias that count toward
 * whatever happened to be written early. Same tokenizing and the same stop
 * words either way, so the two can never disagree about what a phrase IS.
 */
export function collectTrendPhrases(text: string | null | undefined): string[] {
  const { minTokenLength, maxTokenLength, maxPhraseTokens } = MtnConfig.trending.terms;

  const phrases: string[] = [];
  const seen = new Set<string>();

  const push = (phrase: string): void => {
    if (seen.has(phrase)) return;
    seen.add(phrase);
    phrases.push(phrase);
  };

  const cleaned = stripMentionPlaceholders(text ?? '')
    // Mention links first: they are the shape most likely to contain something
    // that looks like prose, so removing them whole has to happen before the
    // generic link rule salvages their label.
    .replace(MENTION_LINK_PATTERN, ' ')
    .replace(MARKDOWN_LINK_PATTERN, '$1 ')
    .replace(URL_PATTERN, ' ')
    // Bare handles BEFORE `@mention`s: the `@mention` pattern would otherwise
    // match the `@instance.tld` half of `someone@instance.tld` and leave the
    // orphaned local part behind as a word.
    .replace(BARE_HANDLE_PATTERN, ' ')
    .replace(MENTION_PATTERN, ' ')
    // The `#` marker goes, the word stays: this single character is the whole
    // difference between `#fifa` and `fifa`, and collapsing it here is what puts
    // tagged and untagged posts about the same thing into one count.
    .replace(/#/g, '');

  for (const segment of cleaned.split(SEGMENT_BOUNDARY)) {
    // Each RUN is a stretch of consecutive keepable tokens. A dropped token
    // (stop word, too short, purely numeric) ends the run rather than being
    // skipped over, so phrases never span a word the writer actually used.
    let run: string[] = [];

    const flush = (): void => {
      for (let start = 0; start < run.length; start++) {
        push(run[start]);
        for (let size = 2; size <= maxPhraseTokens && start + size <= run.length; size++) {
          push(run.slice(start, start + size).join(' '));
        }
      }
      run = [];
    };

    for (const raw of segment.split(' ')) {
      const token = normalizeToken(raw);
      if (!token || !isKeepableToken(raw, token, minTokenLength, maxTokenLength)) {
        flush();
        continue;
      }
      run.push(token);
    }
    flush();
  }

  return phrases;
}

/**
 * Lowercase, strip apostrophes at the EDGES (punctuation), and reduce an
 * English contraction to the word it is built on.
 *
 * `i'll`, `there's` and `don't` reached the stored term lists intact, because
 * an interior apostrophe is part of the token. Every one of them is a pronoun
 * or auxiliary glued to another — the stop-word list holds the base word, and
 * cutting at the apostrophe is what lets it do its job. It also folds `it's`
 * onto `it` rather than leaving two spellings of one function word.
 *
 * The cut is at the FIRST apostrophe, so a possessive (`orioles'`) and a name
 * that contains one (`o'brien`) behave differently on purpose: the possessive
 * loses nothing, and `o'brien` reduces to `o`, which the length floor then
 * drops — a name lost, but a name that no burst can be built on anyway.
 */
function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/^'+|'+$/g, '').split("'")[0];
}

/**
 * Whether a token can carry a trend.
 *
 * The length floor has one exception, and it is load-bearing: a SHORT ALL-CAPS
 * token is an acronym (`AI`, `EU`, `UN`, `F1`), which is exactly the shape of
 * things that trend. Without the exception the floor silently deletes a whole
 * class of real topics, and raising the floor's exception to lowercase would
 * readmit every two-letter particle in six languages.
 */
function isKeepableToken(
  raw: string,
  token: string,
  minTokenLength: number,
  maxTokenLength: number,
): boolean {
  if (token.length > maxTokenLength) return false;
  if (TREND_TERM_STOPWORDS.has(token)) return false;
  // Purely numeric tokens (counts, years, scores) are never the subject.
  if (!/\p{L}/u.test(token)) return false;

  if (token.length >= minTokenLength) return true;
  return token.length >= MIN_ACRONYM_LENGTH && raw === raw.toUpperCase();
}
