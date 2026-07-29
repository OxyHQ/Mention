/**
 * Pure query-string analysis behind the search screen's suggestion rows.
 *
 * These suggestions are LIST CONTENT, not a floating autocomplete: the search
 * screen renders them as a header section above the results, inside the same
 * FlashList. That is a deliberate structural choice — with no overlay there is
 * no dismissal policy to get wrong, so the suggestions cannot "close on blur"
 * (the bug Bluesky fixed in `92ef1528b` by deleting their blur handler). Nothing
 * here knows about focus, and nothing should ever teach it to.
 *
 * Kept free of React and of the service layer so every rule below is unit
 * testable on its own.
 */

/** Operators whose value is a Mention user — the ones `me` is meaningful for. */
const USER_OPERATOR_PREFIXES = ['from', 'to'] as const;

/**
 * Operators with a CLOSED value set, which is what makes completing them
 * honest — every suggestion is a value the backend actually recognizes.
 * `since`/`until`/`min_likes`/`min_boosts` are deliberately absent: their values
 * are open-ended, so there is nothing truthful to offer.
 */
const CLOSED_OPERATOR_VALUES: Record<string, readonly string[]> = {
  has: ['media', 'links'],
};

/** Every operator prefix that can be completed at all. */
const COMPLETABLE_PREFIXES: readonly string[] = [
  ...USER_OPERATOR_PREFIXES,
  ...Object.keys(CLOSED_OPERATOR_VALUES),
];

/** Matches a `prefix:value` token, with the value still possibly empty. */
const OPERATOR_TOKEN = /^([a-z_]+):(.*)$/i;

/**
 * A local `@username`, or a federated `user@domain`. Mirrors the two spellings
 * the `/@handle` route resolves.
 */
const HANDLE_CANDIDATE = /^[a-zA-Z0-9_.-]{1,64}(?:@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)?$/;

/** The operator token the caret currently sits in. */
export interface ActiveOperatorToken {
  /** The operator's prefix, lowercased — e.g. `from`. */
  prefix: string;
  /** What has been typed for the value so far (possibly empty). */
  value: string;
  /** Offset of the token's first character within the query. */
  start: number;
  /** Offset one past the token's last character. */
  end: number;
}

/**
 * The completable operator token the caret sits in, or `null`.
 *
 * The caret is clamped into the query, so a stale caret (the selection event can
 * lag a programmatic text change) degrades to "the last token" rather than
 * pointing at a token that no longer exists.
 */
export function findActiveOperatorToken(query: string, caret: number): ActiveOperatorToken | null {
  const position = Math.max(0, Math.min(caret, query.length));

  let start = position;
  while (start > 0 && !/\s/.test(query[start - 1])) start--;
  let end = position;
  while (end < query.length && !/\s/.test(query[end])) end++;

  const match = OPERATOR_TOKEN.exec(query.slice(start, end));
  if (!match) return null;

  const prefix = match[1].toLowerCase();
  if (!COMPLETABLE_PREFIXES.includes(prefix)) return null;

  return { prefix, value: match[2], start, end };
}

/**
 * The values worth offering for an operator token, narrowed by what has been
 * typed for it so far.
 *
 * For a user operator that is `me` (the viewer) plus the operands the viewer has
 * searched before — read out of their own search history, which is the only
 * record of "recent authors" this screen has and needs no request. A value the
 * user has already typed in full is dropped: re-suggesting it completes nothing.
 */
export function buildOperatorValueSuggestions(
  token: ActiveOperatorToken,
  searchHistory: readonly string[],
  limit: number,
): string[] {
  const closed = CLOSED_OPERATOR_VALUES[token.prefix];
  const candidates = closed
    ? [...closed]
    : ['me', ...recentOperands(searchHistory)];

  const typed = token.value.replace(/^@/, '').toLowerCase();
  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (key === typed || seen.has(key) || !key.startsWith(typed)) continue;
    seen.add(key);
    suggestions.push(candidate);
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}

/**
 * People the viewer has previously named in a search, most recent first.
 *
 * Scans EVERY user operator rather than only the one being typed: the useful
 * set is "people I have searched for", and someone I once wrote `from:` for is
 * just as likely to be who I now mean by `to:`. A leading `@` is stripped so a
 * suggestion matches what the backend resolves, and `me` is dropped because it
 * is always offered first anyway.
 */
function recentOperands(searchHistory: readonly string[]): string[] {
  const pattern = new RegExp(`\\b(?:${USER_OPERATOR_PREFIXES.join('|')}):("[^"]*"|[^\\s]+)`, 'gi');
  const operands: string[] = [];
  for (const entry of searchHistory) {
    for (const match of entry.matchAll(pattern)) {
      const operand = match[1].replace(/^"|"$/g, '').replace(/^@/, '');
      if (operand.length > 0 && operand.toLowerCase() !== 'me') operands.push(operand);
    }
  }
  return operands;
}

/**
 * The query with the active operator token rewritten to `prefix:value`, plus a
 * trailing space so the next keystroke starts a new token. Everything on either
 * side of the token is preserved, so completing an operator never disturbs the
 * rest of a multi-term query.
 */
export function applyOperatorCompletion(
  query: string,
  token: ActiveOperatorToken,
  value: string,
): string {
  const before = query.slice(0, token.start);
  const after = query.slice(token.end);
  // Exactly one space after the completed operator: none when the query already
  // supplies it, one when the completion lands at the very end of the box (which
  // is where it usually lands, and where the viewer keeps typing next).
  const separator = after.startsWith(' ') ? '' : ' ';
  return `${before}${token.prefix}:${value}${separator}${after}`;
}

/**
 * The handle a "Go to @…" row would open, or `null` when the query is not shaped
 * like one.
 *
 * A bare word is NOT treated as a handle: without a leading `@` only the
 * unambiguous federated `user@domain` form qualifies. Otherwise every one-word
 * search would offer a link to a profile that almost never exists.
 */
export function toProfileHandleSuggestion(rawQuery: string): string | null {
  const query = rawQuery.trim();
  const isExplicit = query.startsWith('@');
  const candidate = isExplicit ? query.slice(1) : query;
  if (!HANDLE_CANDIDATE.test(candidate)) return null;
  if (!isExplicit && !candidate.includes('@')) return null;
  return candidate;
}

/**
 * Recent searches that match what is being typed. Filtering them is what keeps
 * the history reachable mid-query instead of hiding it on the first keystroke.
 * The query itself is dropped — offering it back as a "recent" suggests nothing.
 */
export function filterRecentSearches(
  searchHistory: readonly string[],
  query: string,
  limit: number,
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return searchHistory.slice(0, limit);
  return searchHistory
    .filter((entry) => {
      const candidate = entry.toLowerCase();
      return candidate !== needle && candidate.includes(needle);
    })
    .slice(0, limit);
}
