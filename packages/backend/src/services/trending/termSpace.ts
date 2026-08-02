/**
 * Where a trend term lives in the database — and the ONE place that says which
 * of those fields may PROPOSE a trend versus merely match one.
 *
 * Three columns carry a term: the words a post's text is about
 * (`classification_trend_terms`), its canonical hashtags, and the topic slugs
 * our own classifier files it under. The first two are asserted by the AUTHOR;
 * the third is asserted by US.
 *
 * ## Two sets, not one, and the direction between them is a safety rule
 *
 *  - {@link TREND_CANDIDATE_COLUMNS} — author-asserted only. What the detection
 *    batch groups by, so only the network's own vocabulary can trend.
 *  - {@link TREND_TERM_COLUMNS} — all three. What the `trend|<term>` feed and
 *    the diagnostic match by.
 *
 * **Candidates ⊂ matched is the SAFE direction, and it must never be inverted.**
 * A feed matching LESS than detection counted opens a reported trend onto a
 * screen missing exactly the posts that made it trend. Matching MORE can only
 * add posts that are about it — a post we filed under `ukraine` belongs in
 * Ukraine's feed whether or not its author ever wrote the word.
 *
 * `classification_topics` is absent from the candidate set for that reason: a
 * topic slug we assigned must not be able to push a term onto the trend list on
 * its own count.
 *
 * Adding a fourth source column is one edit here rather than three edits and two
 * things nobody remembers to change. (It was three copies before this module;
 * the comment insisting they agree had itself been copied twice.)
 */

import { arrayOverlaps, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { posts } from '../../db/schema/posts';
import { qualified } from '../../db/casing';

/**
 * The columns whose contents may PROPOSE a trend — author-asserted only.
 *
 * `classification_topics` is deliberately absent; see the module comment.
 */
export const TREND_CANDIDATE_COLUMNS: readonly PgColumn[] = [
  posts.classificationTrendTerms,
  posts.hashtags,
];

/** Every column a term can be carried by, in the order they were added. */
export const TREND_TERM_COLUMNS: readonly PgColumn[] = [
  ...TREND_CANDIDATE_COLUMNS,
  posts.classificationTopics,
];

/**
 * Match posts carrying ANY of `terms`, as a predicate.
 *
 * Takes a list because a trend can stand for several terms at once:
 * co-occurrence merges `Ukraine`, `Kyiv` and `Zelensky` into one row, and the
 * row's feed has to show the posts of all three — a merge that concentrated
 * their evidence into one score and then opened onto only one of them would be
 * strictly worse than not merging.
 *
 * `&&` (array-overlap) per column, ORed — the direct analogue of Mongo's
 * `{ field: { $in: terms } }` against a multikey array, and the generalisation
 * of the single-term `@>` this replaced. Each column is GIN-indexed, so the
 * disjunction is a bitmap-OR of index scans rather than a scan.
 *
 * A NULL column (a post that predates the field) yields NULL, not true, so it
 * simply does not match — the same answer Mongo gave for a missing field.
 *
 * Unlike Mongo there is nothing to defend against in the composition: a drizzle
 * `and()` composes, so no cursor can clobber this the way an ASSIGNED `$or`
 * could.
 *
 * **`arrayOverlaps`, never a hand-written `` sql`${column} && ${list}::text[]` ``.**
 * A JS array interpolated into a `sql` template is not bound as an array: drizzle
 * expands it into a ROW CONSTRUCTOR (`($1, $2, $3)::text[]`, verified against the
 * installed dialect), which Postgres refuses to cast — so the whole query THROWS
 * at runtime rather than matching nothing, taking the `trend|<term>` feed with
 * it. Generated-SQL assertions cannot see this; only executing it can.
 * `arrayOverlaps` binds one parameter carrying the array literal.
 */
export function trendTermMatchSql(terms: string | readonly string[]): SQL {
  const list = typeof terms === 'string' ? [terms] : [...terms];
  // An empty list matches NOTHING, which is the honest answer and mirrors
  // Mongo's `$in: []`. Without it `or()` collapses to `undefined` and the
  // predicate would silently match every post.
  if (list.length === 0) return sql`false`;
  return or(...TREND_TERM_COLUMNS.map((column) => arrayOverlaps(column, list))) as SQL;
}

/**
 * The CANDIDATE union as an EXPRESSION — the per-post set of terms the detection
 * batch groups by.
 *
 * Built from {@link TREND_CANDIDATE_COLUMNS}, not every column: a topic slug
 * must not be able to reach the trend list on its own count.
 *
 * The arrays are concatenated and de-duplicated by the caller's
 * `select distinct unnest(...)`, so a post carrying a term BOTH as a hashtag and
 * as an extracted term counts once — Mongo's `$setUnion` deduplicated per
 * document and that is where the property lives now. `coalesce` covers a post
 * that predates a column.
 *
 * `qualified()` rather than a bare column reference: this expression is
 * interpolated into a raw `sql` template that lands in the SELECT LIST of a
 * single-table select, which is the one position where drizzle 0.45.2 renders a
 * column BARE — producing a wrong but perfectly valid query.
 */
export function trendCandidateUnionSql(): SQL {
  return sql.join(
    TREND_CANDIDATE_COLUMNS.map((column) => sql`coalesce(${qualified(column)}, array[]::text[])`),
    sql` || `,
  );
}
