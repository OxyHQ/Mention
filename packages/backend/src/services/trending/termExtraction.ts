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
]);

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
  const { minTokenLength, maxTokenLength, maxPhraseTokens, maxTermsPerPost } =
    MtnConfig.trending.terms;

  const terms: string[] = [];
  const seen = new Set<string>();

  const push = (term: string): void => {
    if (seen.has(term) || terms.length >= maxTermsPerPost) return;
    seen.add(term);
    terms.push(term);
  };

  const cleaned = (input.text ?? '')
    .replace(URL_PATTERN, ' ')
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

/** Lowercase and strip leading/trailing apostrophes, which are punctuation here. */
function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/^'+|'+$/g, '');
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
