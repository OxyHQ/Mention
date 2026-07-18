import { describe, expect, it } from 'vitest';
import { buildTopicSlugMatch } from '../../utils/postTopicMatch';

/**
 * `buildTopicSlugMatch` is the ONE canonical "posts on a topic slug" clause,
 * shared by the topic-page controller (`buildPostsByTopicFilter`) and the MTN
 * topic-feed source (`gatherTopicTimeline`). It must match a post associated
 * with the slug through EITHER form of the canonical topic list — the
 * registry-linked `postClassification.topicRefs.name` OR the slug-only
 * `postClassification.topics` — so the topic feed ranges over the SAME post set
 * TrendingService counts (a topic that trends can never render an empty feed).
 */
describe('buildTopicSlugMatch — canonical topicRefs.name OR slug topics clause', () => {
  it('matches BOTH the canonical topicRefs.name and the slug-only topics (lowercased)', () => {
    expect(buildTopicSlugMatch('Tech')).toEqual({
      $or: [
        { 'postClassification.topicRefs.name': 'tech' },
        { 'postClassification.topics': 'tech' },
      ],
    });
  });

  it('lowercases mixed-case and already-lowercase slugs identically', () => {
    expect(buildTopicSlugMatch('BasketBall')).toEqual(buildTopicSlugMatch('basketball'));
  });

  it('nests cleanly under $and so a sibling cursor $or cannot clobber it', () => {
    const match: Record<string, unknown> = {
      $and: [buildTopicSlugMatch('tech')],
      visibility: 'public',
      status: 'published',
    };
    // A ChronoCursor timestamp cursor sets its own top-level `$or`; the topic OR
    // survives because it lives under `$and`.
    match.$or = [{ createdAt: { $lt: new Date() } }];

    const and = match.$and as Array<Record<string, unknown>>;
    expect(and[0].$or).toEqual([
      { 'postClassification.topicRefs.name': 'tech' },
      { 'postClassification.topics': 'tech' },
    ]);
    expect(match.$or).toHaveLength(1);
  });
});
