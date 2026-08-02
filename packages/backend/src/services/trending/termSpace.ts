/**
 * Where a trend term lives in the database — and the ONE place that says which
 * of those fields may PROPOSE a trend versus merely match one.
 *
 * Three fields carry a term: the words a post's text is about
 * (`postClassification.trendTerms`), its canonical hashtags, and the topic
 * slugs our own classifier files it under. The first two are asserted by the
 * AUTHOR; the third is asserted by US.
 *
 * That difference decides what each field is allowed to do. A topic slug's
 * count answers "how many posts did we file under this drawer", not "how many
 * people are talking about this" — so `news` reached the trending list with
 * five posts and no burst, and a list whose top rows are `AI`, `News` and
 * `Politics` is reporting our own shelving, the way a bookshop would announce
 * that this week's bestseller is "Fiction". A category still belongs on a
 * trend, as the small label above its name; it just cannot BE one.
 *
 * Hence two sets, and the asymmetry between them is deliberate:
 *
 *  - {@link TREND_CANDIDATE_FIELDS} — author-asserted only. What the detection
 *    batch groups by, so only the network's own vocabulary can trend.
 *  - {@link TREND_TERM_FIELDS} — all three. What the `trend|<term>` feed and
 *    the diagnostic match by.
 *
 * Candidates ⊂ matched is the SAFE direction, and it is the one the original
 * single-set comment was really protecting: a feed matching LESS than detection
 * counted opens a reported trend onto a screen missing exactly the posts that
 * made it trend. Matching MORE can only add posts that are about it — a post
 * we filed under `ukraine` belongs in Ukraine's feed whether or not its author
 * ever wrote the word. Never invert this: never let the feed match a subset of
 * what detection counts.
 *
 * Deliberately SEPARATE from `termExtraction`, which is pure and knows nothing
 * about storage. This module is the storage half of the same idea, and keeping
 * the two apart is what lets the extractor stay trivially testable.
 */

/**
 * The fields whose contents may PROPOSE a trend — author-asserted only.
 *
 * `postClassification.topics` is deliberately absent: see the module comment.
 */
export const TREND_CANDIDATE_FIELDS = [
  'postClassification.trendTerms',
  'hashtags',
] as const;

/** Every field a term can be carried by, in the order they were added. */
export const TREND_TERM_FIELDS = [
  ...TREND_CANDIDATE_FIELDS,
  'postClassification.topics',
] as const;

/**
 * Match posts carrying ANY of `terms`, as a query fragment.
 *
 * Takes a list because a trend can stand for several terms at once: co-occurrence
 * merges `Ukraine`, `Kyiv` and `Zelensky` into one row, and the row's feed has to
 * show the posts of all three — a merge that concentrated their evidence into one
 * score and then opened onto only one of them would be strictly worse than not
 * merging.
 *
 * Returned as a bare `$or` so a caller can nest it wherever its own query
 * needs — the feed nests it under `$and` so a cursor's `$or` cannot clobber it.
 */
export function trendTermMatch(
  terms: string | readonly string[],
): { $or: Record<string, { $in: string[] }>[] } {
  const list = typeof terms === 'string' ? [terms] : [...terms];
  return { $or: TREND_TERM_FIELDS.map((field) => ({ [field]: { $in: list } })) };
}

/**
 * The CANDIDATE union as an aggregation EXPRESSION — the per-document set of
 * terms the detection batch groups by.
 *
 * Built from {@link TREND_CANDIDATE_FIELDS}, not every field: a topic slug must
 * not be able to reach the list on its own count.
 *
 * `$setUnion` deduplicates, so a term written both as a hashtag and in the body
 * counts once for that post; `$ifNull` covers a post that predates a field.
 */
export function trendCandidateUnionExpression(): Record<string, unknown> {
  return {
    $setUnion: TREND_CANDIDATE_FIELDS.map((field) => ({ $ifNull: [`$${field}`, []] })),
  };
}
