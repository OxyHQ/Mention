/**
 * Where a trend term lives in the database — ONE definition, three readers.
 *
 * A term is carried by three fields, and which three is a domain decision, not
 * a query detail: the words a post's text is about
 * (`postClassification.trendTerms`), its canonical hashtags, and its classified
 * topic slugs. They are unioned because they are three ways of learning the
 * same fact — that this post is about `fifa`.
 *
 * The definition lives here because it is read from three places that MUST
 * agree, and they fail in different directions when they do not:
 *
 *  - the detection batch, which decides what trends;
 *  - the `trend|<term>` feed, which shows the posts behind one — a feed that
 *    matched less than detection counted would open a reported trend onto a
 *    screen missing exactly the posts that made it trend;
 *  - `inspectTrendTerms`, the diagnostic, which is worthless if it looks
 *    somewhere the real thing does not.
 *
 * Adding a fourth source field is now one edit rather than three edits and two
 * things nobody remembers to change. (It was three copies before this module;
 * the comment insisting they agree had itself been copied twice.)
 *
 * Deliberately SEPARATE from `termExtraction`, which is pure and knows nothing
 * about storage. This module is the storage half of the same idea, and keeping
 * the two apart is what lets the extractor stay trivially testable.
 */

/** The post fields a term can be carried by, in the order they were added. */
export const TREND_TERM_FIELDS = [
  'postClassification.trendTerms',
  'hashtags',
  'postClassification.topics',
] as const;

/**
 * Match posts carrying `term`, as a query fragment.
 *
 * Returned as a bare `$or` so a caller can nest it wherever its own query
 * needs — the feed nests it under `$and` so a cursor's `$or` cannot clobber it.
 */
export function trendTermMatch(term: string): { $or: Record<string, string>[] } {
  return { $or: TREND_TERM_FIELDS.map((field) => ({ [field]: term })) };
}

/**
 * The same union as an aggregation EXPRESSION — the per-document set of terms,
 * for the pipeline that groups by them.
 *
 * `$setUnion` deduplicates, so a term written both as a hashtag and in the body
 * counts once for that post; `$ifNull` covers a post that predates a field.
 */
export function trendTermUnionExpression(): Record<string, unknown> {
  return {
    $setUnion: TREND_TERM_FIELDS.map((field) => ({ $ifNull: [`$${field}`, []] })),
  };
}
