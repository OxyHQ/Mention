/**
 * THE scanner for every inline entity a post body carries, shared by every site
 * that has to find one.
 *
 * Post text is written by people and read by four subsystems — the frontend
 * linkifier, the outbound-federation HTML linkifier, the link-preview extractor
 * and the content classifiers — and each of them used to carry its own answer to
 * "where do the entities start and end?". They disagreed. `#BundesländerTurnier`
 * was the visible symptom (see `./hashtags`), but the mention placeholder had two
 * definitions that differed on whitespace and the URL run had four that differed
 * on the bare-`www.` form and on the terminator.
 *
 * WHY A SCANNER AND NOT A BAG OF REGEX SOURCES. Sharing only the sources leaves
 * every call site applying them SEQUENTIALLY, and a sequence of replaces is
 * order-sensitive in a way a single alternation is not. The classifiers really
 * did strip URLs before hashtags; reversing those two lines would have pulled the
 * `#anchor` out of `https://example.com/page#anchor` first and then matched the
 * URL against the wreckage. One pass over one pattern removes that class of
 * mistake outright — every entity is matched against the ORIGINAL text and the
 * spans come back non-overlapping — instead of leaving each call site to
 * rediscover the right sequence.
 *
 * BE PRECISE ABOUT WHICH ORDER MATTERS. Two plausible-sounding claims about this
 * file are false, and both have been believed here:
 *
 *  - {@link DEFAULT_ENTITY_KINDS} is a SET, not an order. It is read through a
 *    `Set`, so reordering it changes nothing at all.
 *  - Within the pattern, `url` sitting ahead of `hashtag` is NOT what protects
 *    `https://example.com/page#anchor`. An alternation is tried at each POSITION
 *    in turn, so the URL wins by starting earlier and running greedily to
 *    whitespace, whichever order the two alternatives are in. Moving the `url`
 *    alternative last changes no result and fails no test — measured on this file
 *    and on the two commits before it.
 *
 * Exactly ONE step of the assembly order is load-bearing — the markup forms
 * before the sigil group — and it is documented at the sequence itself, in
 * {@link createTextEntityPattern}, next to the code it constrains.
 *
 * HERMES SAFETY. This module ships into the React Native bundle, so it may not
 * contain a Unicode property escape: Hermes has them compiled out and throws at
 * runtime, and a module-load-time regex literal makes that a crash at boot. The
 * character classes come from `./hashtags`, which is generated as explicit
 * code-point ranges for exactly this reason. Neither this file nor that one may
 * write the property-escape notation even inside a comment — the regression gate
 * is a flat text scan, and a gate that needs a parser to tell code from prose is
 * one that eventually gets an exception carved into it.
 */

import {
  HASHTAG_BODY_SOURCE,
  HASHTAG_BOUNDARY_SOURCE,
} from './hashtags';
import {
  UNICODE_LETTER_RANGES,
  UNICODE_MARK_RANGES,
  UNICODE_NUMBER_RANGES,
} from './hashtagRanges.generated';

/** Every inline entity kind this module knows how to find. */
export type TextEntityKind =
  | 'url'
  | 'mentionPlaceholder'
  | 'mentionDisplay'
  | 'bareHandle'
  | 'hashtag'
  | 'cashtag';

/**
 * One entity located in a body.
 *
 * `raw`/`start`/`end` describe the span to REPLACE (sigil and markup included),
 * while `value` is the payload to act on. Keeping both is what lets a caller
 * rebuild the text around a match without re-deriving where the match began —
 * the arithmetic every one of these call sites used to do by hand, differently.
 */
export interface TextEntity {
  kind: TextEntityKind;
  /** The full matched text, including `#`, `$`, or the surrounding markup. */
  raw: string;
  /** Index of the first character of {@link raw} in the scanned string. */
  start: number;
  /** Index one past the last character of {@link raw}. */
  end: number;
  /**
   * The entity's payload, sigil and markup stripped:
   *
   *  - `url`                the URL exactly as written (no scheme normalization,
   *                         no trailing-punctuation trim — see
   *                         {@link trimUrlTrailingPunctuation})
   *  - `mentionPlaceholder` the Oxy user id
   *  - `mentionDisplay`     the link target (a username or `handle@instance`)
   *  - `bareHandle`         the handle without its `@`
   *  - `hashtag`            the tag without its `#`
   *  - `cashtag`            the symbol without its `$`
   */
  value: string;
  /** The visible label. `mentionDisplay` only; `undefined` for every other kind. */
  label?: string;
}

/** Options for {@link scanTextEntities}. */
export interface ScanTextEntitiesOptions {
  /**
   * Which kinds to look for. Defaults to all of them.
   *
   * This is a filter on the ONE pattern, not a different pattern: a kind that is
   * switched off still cannot be matched by another kind, because precedence is
   * decided before the filter applies. Turning off `url` therefore does not make
   * `https://example.com/#tag` start yielding a `#tag` hashtag.
   */
  kinds?: readonly TextEntityKind[];
  /**
   * Where a URL run stops.
   *
   *  - `'whitespace'` (default) — at whitespace, for plain text.
   *  - `'html'` — at whitespace or `<`, for a body being rendered INTO HTML,
   *    where a following tag would otherwise be swallowed into the href.
   */
  urlTerminator?: 'whitespace' | 'html';
  /**
   * Whether a scheme-less `www.example.com` counts as a URL. Default `true`.
   *
   * Off for callers that COUNT links as a bot/spam signal or resolve them as
   * citations: those need a thing that is definitely a link, and a bare `www.`
   * run has no scheme to fetch. On for callers that linkify or preview, where
   * the user plainly meant a link and {@link toOpenableUrl} can supply the
   * scheme.
   */
  bareWww?: boolean;
}

/**
 * The default SET of kinds — every kind, because a caller who asks for nothing
 * specific wants everything found.
 *
 * NOT the match order, despite reading like one: this is consumed as a `Set`, so
 * reordering it changes nothing. The alternation order is the
 * `alternatives.push` sequence in {@link createTextEntityPattern}, and the one
 * step of it that is load-bearing is explained there, next to the code it
 * constrains.
 */
const DEFAULT_ENTITY_KINDS: readonly TextEntityKind[] = [
  'mentionDisplay',
  'mentionPlaceholder',
  'url',
  'bareHandle',
  'hashtag',
  'cashtag',
];

/**
 * The `[@Label](target)` form the backend hydrates a stored mention into
 * (`PostHydrationService`), and the only mention form a reader ever sees.
 *
 * Both parts are "anything up to the closing bracket", because a display name is
 * arbitrary user text — it may contain spaces, punctuation, or another `@`.
 */
const MENTION_DISPLAY_SOURCE = '\\[@(?<mdLabel>[^\\]]+)\\]\\((?<mdTarget>[^)]+)\\)';

/**
 * The `[mention:<id>]` placeholder a mention is STORED as.
 *
 * The id may not contain whitespace. This was the stricter of the two
 * definitions that used to exist, and it is the right one: ids are Oxy user ids,
 * the write boundary that reconciles a post's mentions against its allowlist
 * already used it, and under the looser `[^\]]+` a hand-typed
 * `[mention:foo bar]` was consumed here as a placeholder while being incapable
 * of ever matching an authorized id. Rejecting it outright — so it renders as
 * the literal text somebody typed — is what the two ends already agreed on
 * everywhere it mattered.
 */
const MENTION_PLACEHOLDER_SOURCE = '\\[mention:(?<mentionId>[^\\]\\s]+)\\]';

/**
 * A stock ticker: `$AAPL`, `$BRK.B`. Upper-case only and short, because the
 * lower-case and long forms are overwhelmingly prose (`$100`, `$ave`).
 */
const CASHTAG_SOURCE = '\\$(?<cashtag>[A-Z]{1,6}(?:\\.[A-Z]{1,2})?)';

/**
 * A bare `@handle` typed into prose, as opposed to the two markup forms.
 *
 * Letters, numbers, combining marks, `_`, `.` and `-`. Marks are in for the same
 * reason they are in a hashtag: in Devanagari, Arabic, Thai and decomposed
 * Vietnamese a written letter is not one code point, so a class without them
 * ends the handle mid-grapheme and leaves the orphaned marks behind as prose.
 *
 * `@` is deliberately NOT in the class, which together with the shared leading
 * boundary is what keeps this off an email-shaped `someone@instance.tld`: the
 * `@` there is preceded by `e`, a continuation character, so no handle opens.
 * That hazard is real and documented — trending once harvested this instance's
 * own domain out of `@someone@mention.earth` — and it is why a two-part
 * federated handle stays a DIFFERENT entity, owned by `termExtraction`, rather
 * than being folded in here.
 *
 * `-` is last in the class body so it reads as a literal, not a range.
 */
const HANDLE_BODY_SOURCE =
  `[${UNICODE_LETTER_RANGES}${UNICODE_NUMBER_RANGES}${UNICODE_MARK_RANGES}_.-]+`;

/** Build the URL alternative for the requested terminator and `www.` policy. */
function urlSource(terminator: 'whitespace' | 'html', bareWww: boolean): string {
  // `<` ends a run only in HTML mode; in plain text it is an ordinary character
  // that can legitimately appear in a URL's query string.
  const stop = terminator === 'html' ? '[^\\s<]' : '[^\\s]';
  const scheme = `https?:\\/\\/${stop}+`;
  return bareWww ? `(?<url>${scheme}|www\\.${stop}+)` : `(?<url>${scheme})`;
}

/**
 * The sigil entities (`#tag`, `$TICKER`, `@handle`) share one leading
 * word-boundary guard, so a sigil landing inside a word opens nothing — `a#b`,
 * `US$5` and the `@` of `someone@instance.tld` are not entities.
 *
 * The guard CONSUMES the preceding character rather than using a lookbehind. A
 * lookbehind would be tidier and Hermes is documented to support it, but this
 * regex is built at module load on a phone: if that documentation is wrong the
 * app does not mis-render, it fails to boot. The consuming form is what is
 * already proven on device, and the cost of keeping it — adjusting `start` past
 * the boundary character — is paid once, here, instead of at every call site.
 */
function sigilSource(kinds: ReadonlySet<TextEntityKind>): string {
  const alternatives: string[] = [];
  if (kinds.has('hashtag')) alternatives.push(`#(?<hashtag>${HASHTAG_BODY_SOURCE})`);
  if (kinds.has('cashtag')) alternatives.push(CASHTAG_SOURCE);
  if (kinds.has('bareHandle')) alternatives.push(`@(?<handle>${HANDLE_BODY_SOURCE})`);
  if (alternatives.length === 0) return '';
  return `(?<boundary>^|${HASHTAG_BOUNDARY_SOURCE})(?:${alternatives.join('|')})`;
}

/**
 * Compile the one pattern for a given option set.
 *
 * A fresh `RegExp` per scan is deliberate. A shared `/g` instance carries mutable
 * `lastIndex`, so two concurrent scans — or one that returns early — corrupt each
 * other; that is a bug that reproduces only under interleaving and is invisible in
 * a unit test. Compilation is cheap next to the work every caller does with the
 * result, and callers that scan in a hot loop hold their own compiled pattern via
 * {@link createTextEntityPattern}.
 */
export function createTextEntityPattern(options: ScanTextEntitiesOptions = {}): RegExp {
  const {
    kinds = DEFAULT_ENTITY_KINDS,
    urlTerminator = 'whitespace',
    bareWww = true,
  } = options;

  const wanted = new Set(kinds);
  const alternatives: string[] = [];

  // THIS SEQUENCE IS THE ALTERNATION ORDER. One step of it is load-bearing: the
  // MARKUP forms must come before the sigil group.
  //
  // An alternation only decides between alternatives that can begin at the SAME
  // index, which is why most of this order is free — moving `url` last changes
  // no result and fails no test. `[@Ada](ada)` is the exception. `[` is not a
  // word character, so it is a legal leading boundary for a sigil, and the sigil
  // group can therefore match `@Ada` at the very same index 0 where the
  // display-mention markup starts. Whichever is written first wins; if that were
  // the sigil group, every hydrated mention in the product would degrade to a
  // bare handle carrying the display NAME instead of a link to the account.
  //
  // Moving `sigilSource` above these two turns seven tests red, the first of
  // which asserts this rule by name rather than tripping over it. Only reachable
  // since `bareHandle` was added: before it the sigil group could not begin with
  // `@` at all, and no ordering in this function changed anything.
  if (wanted.has('mentionDisplay')) alternatives.push(MENTION_DISPLAY_SOURCE);
  if (wanted.has('mentionPlaceholder')) alternatives.push(MENTION_PLACEHOLDER_SOURCE);
  if (wanted.has('url')) alternatives.push(urlSource(urlTerminator, bareWww));
  // The sigil entities share ONE boundary group, so they contribute a single
  // alternative rather than one each — which is also why they cannot be
  // reordered relative to one another.
  const sigils = sigilSource(wanted);
  if (sigils) alternatives.push(sigils);

  if (alternatives.length === 0) {
    throw new Error('scanTextEntities: `kinds` selected no entity kinds to match');
  }

  // `u` is required: the hashtag class bodies carry astral escapes.
  return new RegExp(alternatives.join('|'), 'gu');
}

/**
 * Find every entity in `text`, in reading order, non-overlapping.
 *
 * The returned spans partition the text with the plain runs between them, which
 * is what both linkifiers need: walk the list, emit `text.slice(cursor, start)`
 * as plain text, emit the entity, set `cursor = end`.
 */
export function scanTextEntities(
  text: string,
  options: ScanTextEntitiesOptions = {},
): TextEntity[] {
  if (!text) return [];

  const pattern = createTextEntityPattern(options);
  const entities: TextEntity[] = [];

  for (const match of text.matchAll(pattern)) {
    const groups = match.groups ?? {};
    const matchStart = match.index ?? 0;

    // The boundary character is context, not part of the entity — step over it
    // so `start` points at the `#` or `$` itself.
    const boundary = groups.boundary ?? '';
    const start = matchStart + boundary.length;
    const raw = boundary ? match[0].slice(boundary.length) : match[0];

    const entity = classify(groups, raw, start);
    if (entity) entities.push(entity);
  }

  return entities;
}

/** Turn one match's named groups into a {@link TextEntity}. */
function classify(
  groups: Record<string, string | undefined>,
  raw: string,
  start: number,
): TextEntity | null {
  const end = start + raw.length;

  if (groups.mdTarget !== undefined) {
    return {
      kind: 'mentionDisplay',
      raw,
      start,
      end,
      value: groups.mdTarget,
      label: groups.mdLabel ?? '',
    };
  }
  if (groups.mentionId !== undefined) {
    return { kind: 'mentionPlaceholder', raw, start, end, value: groups.mentionId };
  }
  if (groups.url !== undefined) {
    return { kind: 'url', raw, start, end, value: groups.url };
  }
  if (groups.handle !== undefined) {
    // `.` and `-` are in the handle class because a handle can legitimately
    // contain them (`@alice.bsky.social`, `@some-name`) — but it cannot END with
    // one, and prose puts a full stop straight after a handle constantly. Left
    // as matched, `Now building @thinkymachines.` yielded the handle
    // `thinkymachines.` with the sentence's period inside it: every consumer
    // then linkified, stored or qualified a handle nobody typed.
    //
    // Trimmed HERE rather than at a call site because there are nine of them and
    // "what may end a handle" is a property of the handle, not of any one
    // consumer. Same reasoning as {@link trimUrlTrailingPunctuation} for URLs.
    const handle = groups.handle.replace(/[.-]+$/, '');
    // A handle of nothing but punctuation (`@...`) is not a handle at all.
    if (handle.length === 0) return null;
    return { kind: 'bareHandle', raw: `@${handle}`, start, end: start + handle.length + 1, value: handle };
  }
  if (groups.hashtag !== undefined) {
    return { kind: 'hashtag', raw, start, end, value: groups.hashtag };
  }
  if (groups.cashtag !== undefined) {
    return { kind: 'cashtag', raw, start, end, value: groups.cashtag };
  }
  return null;
}

/** Options for {@link stripTextEntities}. */
export interface StripTextEntitiesOptions extends ScanTextEntitiesOptions {
  /**
   * What each entity is replaced BY. Defaults to a single space.
   *
   * A space rather than an empty string, because these strips feed text
   * ANALYSIS: deleting a `#tag` outright fuses the words either side of it into
   * one token that nobody wrote.
   */
  replacement?: string;
}

/**
 * Remove every matching entity from `text`, for callers that measure the PROSE
 * left behind rather than the entities themselves — the spam and low-effort
 * classifiers, which ask how much a post says once its decoration is discounted.
 *
 * Shares the scan with the linkifiers on purpose: a body's decoration is exactly
 * what the renderer turns into links, so the two answers agreeing is the point.
 * Before this, the classifiers accepted `#2026` as a tag while the extractor did
 * not, and cut a Devanagari tag mid-grapheme, leaving its orphaned combining
 * marks behind to be counted as prose.
 */
export function stripTextEntities(text: string, options: StripTextEntitiesOptions = {}): string {
  if (!text) return text;

  const { replacement = ' ', ...scanOptions } = options;

  let out = '';
  let cursor = 0;
  for (const entity of scanTextEntities(text, scanOptions)) {
    out += text.slice(cursor, entity.start) + replacement;
    cursor = entity.end;
  }
  return out + text.slice(cursor);
}

/** Count located entities by kind, for callers that need both the strip and the tally. */
export function countTextEntities(
  entities: readonly TextEntity[],
  kind: TextEntityKind,
): number {
  let total = 0;
  for (const entity of entities) if (entity.kind === kind) total += 1;
  return total;
}

/**
 * Sentence punctuation that is almost never part of a URL.
 *
 * A URL run is matched greedily to the next whitespace, because a URL may
 * legitimately end in most characters; deciding what actually belongs to the
 * SENTENCE rather than the link is a separate judgement, made here.
 */
const TRAILING_URL_PUNCTUATION = new Set([
  '.', ',', ';', ':', '!', '?', '"', "'", '’', '”', '»',
]);

/**
 * Closing brackets, which are trimmed only when UNBALANCED.
 *
 * Both of these appear at the end of real URLs — `…/Foo_(disambiguation)` on
 * Wikipedia, and the `]` closing an IPv6 host in `http://[::1]` — and both also
 * appear as prose wrapping a link, as in `(see https://x.com)`. Counting is what
 * separates the two; an unconditional trim silently truncates the first form,
 * which for the IPv6 case produces a URL that no longer parses.
 */
const BALANCED_URL_BRACKETS: ReadonlyMap<string, string> = new Map([
  [')', '('],
  [']', '['],
]);

/** Count occurrences of a single character in a string. */
function countChar(text: string, char: string): number {
  let total = 0;
  for (const candidate of text) if (candidate === char) total += 1;
  return total;
}

/**
 * Split a matched URL run into the link and the prose punctuation trailing it,
 * so `see https://x.com.` links `https://x.com` and leaves the full stop as text.
 */
export function trimUrlTrailingPunctuation(raw: string): { url: string; trailing: string } {
  let end = raw.length;
  while (end > 0) {
    const char = raw[end - 1];
    const opener = BALANCED_URL_BRACKETS.get(char);

    if (opener !== undefined) {
      const head = raw.slice(0, end);
      // Balanced → the bracket belongs to the URL, and so does everything left
      // of it, so the trim stops here.
      if (countChar(head, char) <= countChar(head, opener)) break;
    } else if (!TRAILING_URL_PUNCTUATION.has(char)) {
      break;
    }
    end -= 1;
  }
  return { url: raw.slice(0, end), trailing: raw.slice(end) };
}

/**
 * Give a matched URL a scheme so it can be opened or fetched — a bare `www.`
 * match has none.
 *
 * Tests for the scheme rather than for a `www.` prefix: the input here is a
 * value this module matched, and the two alternatives are "has a scheme" and
 * "starts with `www.`", so the absence of the former is exactly the latter.
 */
export function toOpenableUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Qualify the bare `@handle`s in a federated actor's own text with the network
 * they belong to: `@thinkymachines` → `@thinkymachines@x.com`.
 *
 * WHY THE TEXT IS AMBIGUOUS WITHOUT IT. A bio or post written on X says
 * `@openai` and means the account on X. Copied onto the fediverse verbatim, that
 * same string reads as a LOCAL handle — so a reader on mention.earth sees
 * `@openai` and, if anything links it, is sent to whoever holds that name here.
 * The handle is only meaningful next to the network it was written on, and that
 * context is lost the moment the text crosses over.
 *
 * WHY AT WRITE TIME. Storing the qualified form means every reader — feed,
 * profile, search, export, another server pulling our actor — gets the same
 * unambiguous text from the same field, with no renderer left to re-derive it
 * and no chance of two of them disagreeing. A render-time rewrite would have to
 * carry the origin network to every surface that displays a bio.
 *
 * WHAT IT DELIBERATELY LEAVES ALONE, all decided by {@link scanTextEntities}
 * rather than re-tested here:
 *
 *  - anything inside a URL — `https://x.com/@handle` is one `url` entity, and
 *    the `@handle` within it is never a separate match;
 *  - an email-shaped `someone@instance.tld`, which opens no handle at all;
 *  - a handle that is ALREADY qualified. The scanner treats a two-part handle as
 *    a different entity it does not own, so `@alice@mastodon.social` arrives as
 *    the bare `@alice` — appending blindly would produce
 *    `@alice@x.com@mastodon.social`. The `@` that follows is what tells them
 *    apart, and it is the one case this function has to judge for itself.
 *
 * Pure and allocation-light: one scan, and the string is only rebuilt when there
 * is something to change.
 */
export function qualifyBareHandles(text: string, networkDomain: string): string {
  const domain = networkDomain.trim().toLowerCase();
  if (!text || !domain) return text;

  // Scanned with EVERY kind, never `kinds: ['bareHandle']`. Precedence is
  // decided before the filter, so narrowing the scan does not stop a URL's
  // `@handle` from matching — it stops the URL from being reported while the
  // handle inside it still is. The full scan is what keeps links intact.
  const entities = scanTextEntities(text);

  let result = '';
  let cursor = 0;
  for (const entity of entities) {
    if (entity.kind !== 'bareHandle') continue;
    // Already qualified — the scanner hands back only the local part.
    if (text[entity.end] === '@') continue;
    result += text.slice(cursor, entity.end) + `@${domain}`;
    cursor = entity.end;
  }
  return cursor === 0 ? text : result + text.slice(cursor);
}
