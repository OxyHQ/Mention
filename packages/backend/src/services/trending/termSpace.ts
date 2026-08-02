/**
 * Where a trend term lives in the database — ONE definition, three readers.
 *
 * A term is carried by three columns, and which three is a domain decision, not
 * a query detail: the words a post's text is about
 * (`classification_trend_terms`), its canonical hashtags, and its classified
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
 * Adding a fourth source column is now one edit rather than three edits and two
 * things nobody remembers to change. (It was three copies before this module;
 * the comment insisting they agree had itself been copied twice.)
 *
 * Deliberately SEPARATE from `termExtraction`, which is pure and knows nothing
 * about storage. This module is the storage half of the same idea, and keeping
 * the two apart is what lets the extractor stay trivially testable.
 */

import { or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { posts } from '../../db/schema/posts';
import { qualified } from '../../db/casing';

/** The post columns a term can be carried by, in the order they were added. */
export const TREND_TERM_COLUMNS: readonly PgColumn[] = [
  posts.classificationTrendTerms,
  posts.hashtags,
  posts.classificationTopics,
];

/**
 * Match posts carrying `term`, as a predicate.
 *
 * `@>` (array-contains) per column, ORed — the direct analogue of Mongo matching
 * a scalar against a multikey array. Each column is GIN-indexed, so the
 * disjunction is a bitmap-OR of three index scans rather than a scan.
 *
 * A NULL column (a post that predates the field) yields NULL from `@>`, not
 * true, so it simply does not match — which is the same answer Mongo gave for a
 * missing field and is what the caller wants either way.
 */
export function trendTermMatchSql(term: string): SQL {
  return or(...TREND_TERM_COLUMNS.map((column) => sql`${column} @> array[${term}]::text[]`)) as SQL;
}

/**
 * The same union as an EXPRESSION — the per-post set of terms, for the
 * aggregation that groups by them.
 *
 * The three arrays are concatenated and then de-duplicated by the caller's
 * `unnest` + `group by`, so a term written both as a hashtag and in the body
 * counts once for that post; `coalesce` covers a post that predates a column.
 *
 * `qualified()` rather than a bare column reference: this expression is
 * interpolated into a raw `sql` template that lands in the SELECT LIST of a
 * single-table select, which is the one position where drizzle 0.45.2 renders a
 * column BARE — producing a wrong but perfectly valid query.
 */
export function trendTermUnionSql(): SQL {
  return sql.join(
    TREND_TERM_COLUMNS.map((column) => sql`coalesce(${qualified(column)}, array[]::text[])`),
    sql` || `,
  );
}
