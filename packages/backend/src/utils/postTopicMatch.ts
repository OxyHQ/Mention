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
  const normalized = slug.toLowerCase();
  return {
    $or: [
      { 'postClassification.topicRefs.name': normalized },
      { 'postClassification.topics': normalized },
    ],
  };
}
