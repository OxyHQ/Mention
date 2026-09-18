/**
 * LIKE/ILIKE pattern building, with the term's own metacharacters escaped.
 *
 * This existed FOUR times — `routes/lists.ts`, `routes/starterPacks.ts`,
 * `routes/customFeeds.routes.ts` and `services/LabelService.ts` — as
 * byte-identical private copies. That is not a style problem: the escaping is
 * the security-relevant half, so four copies are four places for one of them to
 * be written slightly differently, and the failure is silent. A search for
 * `100%` against an unescaped pattern matches EVERY row, and nothing about the
 * response says the filter was ignored.
 *
 * `%`, `_` and the escape character itself are all that LIKE gives meaning to,
 * which is why this is three characters and not a general SQL escape: the term
 * is always passed as a BOUND PARAMETER, so nothing here is defending against
 * injection — only against the caller's text being read as a pattern.
 */

/** Escape the three characters LIKE treats as special. */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** `%term%` — a substring match. */
export function likeContains(term: string): string {
  return `%${escapeLikeTerm(term)}%`;
}

/**
 * `term%` — an anchored prefix match.
 *
 * The form a trigram index cannot serve and a `text_pattern_ops` btree can:
 * `pg_trgm` extracts trigrams only from a pattern's wildcard-free runs, so a
 * term shorter than three characters yields none and leaves
 * {@link likeContains} with no index to use at all.
 */
export function likeStartsWith(term: string): string {
  return `${escapeLikeTerm(term)}%`;
}
