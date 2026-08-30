/**
 * NAMING EVIDENCE — a few recent posts carrying a term, which is what turns a
 * generated label into something better than string formatting.
 *
 * The term alone cannot name a story (`orioles` does not contain the words
 * "Kremer Trade"), so both the batch labeller and the on-demand trend summary
 * read their evidence from here — one query shape, one ordering contract, one
 * fail-soft rule, rather than two implementations that could drift.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';
import { getDb } from '../../db/postgres';
import { postContentVariants } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import { logger } from '../../utils/logger';
import { trendTermMatchSql } from './termSpace';
import { sensitiveExcludeSql } from '../../mtn/feed/feedSafety';

/**
 * Posts sampled per term as naming evidence.
 *
 * Twelve, not three: the labeller asks which phrase MOST of the posts share, and
 * a majority of three is two — a coincidence, not a consensus. Twelve is a
 * single indexed lookup with a text-only projection, and it only runs for terms
 * that have no label yet.
 */
const TREND_EXCERPTS_PER_TERM = 12;

/**
 * A few recent posts carrying ONE term, as naming evidence — the per-term
 * query, unchanged, and the branch {@link loadExcerptsByTerm} submits.
 *
 * The term alone cannot name a story — `orioles` does not contain the words
 * "Kremer Trade" — so this is what makes a generated label better than string
 * formatting. Matched across the same three columns the term space is built
 * from, so a term that arrived as a hashtag or a topic slug still finds its
 * posts.
 *
 * The body comes from the PRIMARY rendition (`position = 0` of
 * `post_content_variants`), which is the author's own words — the same one the
 * Mongo projection took. Ordered by `created_at` alone with no id tie-break:
 * `posts.id` mixes ObjectId hex and uuid v7 and is not a chronological axis,
 * and for a sample of twelve an arbitrary tie is not worth a wrong order.
 *
 * `created_at` rides along in the projection so the caller can restate the
 * per-term order on the combined result rather than inheriting it from the
 * order rows happen to arrive in. It is never read in JS — only the outer
 * `order by` consumes it — so it is not a raw-date-decoding hazard.
 *
 * THE INNER JOIN IS LOAD-BEARING AND CANNOT BE HOISTED. A post with no
 * rendition (`insertPostRecord` writes none for empty `content.variants`) is
 * eliminated by it, so it does not consume one of the twelve slots. Postgres
 * evaluates this efficiently — the `LIMIT` sits ABOVE the join, so the
 * rendition is fetched for the twelve surviving posts and no others — and that
 * plan is what any batching has to preserve.
 */
export function termExcerptBranch(term: string) {
  return getDb()
    .select({ body: postContentVariants.body, createdAt: posts.createdAt })
    .from(posts)
    .innerJoin(
      postContentVariants,
      and(
        eq(postContentVariants.postId, posts.id),
        eq(postContentVariants.position, 0),
      ),
    )
    .where(and(
      trendTermMatchSql(term),
      eq(posts.status, 'published'),
      eq(posts.visibility, PostVisibility.PUBLIC),
      sensitiveExcludeSql(),
    ))
    .orderBy(desc(posts.createdAt))
    .limit(TREND_EXCERPTS_PER_TERM);
}

/**
 * Naming evidence for a WHOLE batch of terms, in ONE statement.
 *
 * ## Why `union all` of the verbatim per-term query, and not a lateral
 *
 * The obvious batching — `unnest(terms)` cross-joined lateral to the per-term
 * query — is **18x worse**, and the reason generalizes. With a constant term
 * the planner estimates the three-way `BitmapOr` accurately (~2,000 rows) and
 * keeps the `LIMIT` above the rendition join, so it fetches twelve renditions.
 * Correlate the term to a lateral column and that estimate is gone: the
 * planner switches to a hash join and sequentially scans all 400,000
 * renditions once per term. Measured on a 400k-post corpus, 12 terms:
 *
 * ```
 *   per-term, 12 statements   9,419 buffers   65.7 ms   12 plans
 *   union all, 1 statement    9,422 buffers   47.0 ms    1 plan
 *   lateral,   1 statement  168,632 buffers  593.6 ms    1 plan
 * ```
 *
 * So the win here is NOT less work — it is the same work, and saying so is the
 * point: the buffers are identical to three digits. What changes is how it is
 * DEMANDED. The `Promise.all` this replaces issued twelve statements at once,
 * holding twelve pool connections and asking for `3 x maxPerBatch` parallel
 * workers simultaneously on an instance that also serves requests. An `Append`
 * runs its branches one at a time, so the same total work now peaks at one
 * branch's worth of workers and one connection.
 *
 * ## Fail-soft, and how its SHAPE changed
 *
 * Per-term, a failed lookup cost one term its evidence. Batched, a failure is
 * the whole batch's — so the catch degrades every term to no evidence and a
 * weaker label rather than throwing, and logs ONCE rather than per term. The
 * map is seeded with an empty list for every term before the query runs, which
 * is also what guarantees the OTHER contract: a term matching no posts keeps
 * its entry instead of vanishing from the result and silently becoming a
 * missing key at the call site.
 */
export async function loadExcerptsByTerm(terms: readonly string[]): Promise<Map<string, string[]>> {
  const byTerm = new Map<string, string[]>(terms.map((term) => [term, []]));
  if (byTerm.size === 0) return byTerm;

  // Deduped, because two identical branches would do the work twice for one
  // answer. `ranked` groups by term so this is defensive, not corrective.
  const unique = [...byTerm.keys()];

  try {
    const branches = unique.map((term, ord) => sql`
      select ${term}::text as term, ${ord}::int as ord, branch.body, branch.created_at
      from (${termExcerptBranch(term)}) as branch
    `);

    // `ord` then `created_at desc` RESTATES the ordering rather than trusting
    // the order an `Append` happens to emit. Nothing in SQL guarantees that
    // order, and the per-term sequence is the whole contract here: a batching
    // rewrite that reorders a term's evidence silently changes its label.
    const rows = await getDb().execute<{ term: string; body: string | null }>(sql`
      select combined.term, combined.body
      from (${sql.join(branches, sql` union all `)}) as combined
      order by combined.ord, combined.created_at desc
    `);

    for (const row of rows) {
      const text = row.body?.trim() ?? '';
      if (text.length > 0) byTerm.get(row.term)?.push(text);
    }
  } catch (error) {
    logger.warn(
      '[Trending] Excerpt lookup failed; labelling the whole batch without evidence',
      { terms: unique.length, error },
    );
    for (const term of unique) byTerm.set(term, []);
  }

  return byTerm;
}
