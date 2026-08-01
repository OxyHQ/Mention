import { and, arrayContains, eq, exists, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { postClassificationTopicRefs, posts } from '../db/schema';

/**
 * Canonical "posts associated with a topic slug" match clause.
 *
 * A post is associated with a topic through EITHER form of the ONE canonical
 * topic list:
 *   - the registry-linked `postClassification.topicRefs` (Stage-B AI enrichment)
 *     — each element carries a lowercase slug `name`, and
 *   - the slug-only `postClassification.topics` array (Stage-A rule baseline).
 *
 * `TrendingService.aggregateTopics` counts a topic from those SAME two sources
 * (it reads `topicRefs` when present and falls back to `topics`, grouping by the
 * slug `name`). Every topic-scoped Post query therefore matches BOTH fields via
 * this one helper, so the topic FEED and the TRENDING aggregation always range
 * over an identical post set — a topic that trends can never render an empty
 * feed, and the two match rules can never drift onto different fields again
 * (which was the original "trends but no posts" bug).
 *
 * Slugs are stored lowercase, so the lookup lowercases for index efficiency
 * (backed by `{ 'postClassification.topicRefs.name': 1, createdAt: -1 }` and
 * `{ 'postClassification.topics': 1, visibility: 1, status: 1, createdAt: -1 }`).
 *
 * The clause is a bare top-level `$or`. Callers that also let a cursor helper
 * (e.g. `ChronoCursor`) add its own `$or` MUST nest this under `$and` so the two
 * `$or`s cannot clobber each other.
 */
export function buildTopicSlugMatch(slug: string): {
  $or: Array<Record<string, string>>;
} {
  const normalized = normalizeTopicSlug(slug);
  return {
    $or: [
      { 'postClassification.topicRefs.name': normalized },
      { 'postClassification.topics': normalized },
    ],
  };
}

/**
 * The one normalization rule, extracted so the two encodings below cannot
 * disagree about it.
 *
 * This is the part most likely to drift — it is a single `toLowerCase()` that
 * looks too trivial to share, and a topic page that silently returns nothing
 * because one side lowercased and the other did not is precisely the failure
 * this module was created to end.
 */
export function normalizeTopicSlug(slug: string): string {
  return slug.toLowerCase();
}

/**
 * SQL encoding of the SAME rule as {@link buildTopicSlugMatch}.
 *
 * ## Why both encodings exist right now
 *
 * The migration is batched, and this module is read from BOTH sides of the
 * in-flight boundary: the feed sources (ported here) and
 * `posts.controller.ts` `buildPostsByTopicFilter` (not yet ported). A helper
 * that spans an unfinished cutover has to speak both stores for exactly as long
 * as that is true.
 *
 * The Mongo form is therefore NOT a shim to keep around: it is deleted by
 * whichever batch ports `posts.controller.ts`, and this comment is the note
 * telling that batch to do it. What makes the interim safe is that the two
 * encodings share {@link normalizeTopicSlug} and are asserted to select the same
 * posts by test — the fields themselves are the whole content of the rule and
 * are stated once per store.
 *
 * `= ANY(array)` is the array-membership test for the slug-only `text[]` column
 * — the direct analogue of Mongo matching an array field by element equality.
 * Written through `arrayContains` rather than a hand-rolled `= any(${slug})`,
 * because a raw JS value interpolated on the right of `ANY` binds as a ROW
 * constructor and Postgres rejects it.
 */
export function topicSlugSql(slug: string): SQL {
  const normalized = normalizeTopicSlug(slug);
  return or(
    exists(
      getDb()
        .select({ one: sql`1` })
        .from(postClassificationTopicRefs)
        .where(
          and(
            eq(postClassificationTopicRefs.postId, posts.id),
            eq(postClassificationTopicRefs.name, normalized),
          ),
        ),
    ),
    arrayContains(posts.classificationTopics, [normalized]),
  ) as SQL;
}
