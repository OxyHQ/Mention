import { and, arrayContains, eq, exists, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { postClassificationTopicRefs, posts } from '../db/schema';

/**
 * The one normalization rule, extracted so every caller agrees on it.
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
 * Canonical "posts associated with a topic slug" match clause.
 *
 * A post is associated with a topic through EITHER form of the ONE canonical
 * topic list:
 *   - the registry-linked `post_classification_topic_refs` rows (Stage-B AI
 *     enrichment) — each carries a lowercase slug `name`, and
 *   - the slug-only `posts.classification_topics` array (Stage-A rule baseline).
 *
 * `TrendingService.aggregateTopics` counts a topic from those SAME two sources
 * (it reads the refs when present and falls back to the slug array, grouping by
 * the slug `name`). Every topic-scoped post query therefore matches BOTH via
 * this one helper, so the topic FEED and the TRENDING aggregation always range
 * over an identical post set — a topic that trends can never render an empty
 * feed, and the two match rules can never drift onto different fields again
 * (which was the original "trends but no posts" bug).
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
