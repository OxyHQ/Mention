import { describe, expect, it } from 'vitest';
import { normalizeTopicSlug } from '../../utils/postTopicMatch';

/**
 * `normalizeTopicSlug` is shared by the topic-page controller
 * (`buildPostsByTopicFilter`) and the MTN topic-feed source
 * (`gatherTopicTimeline`) through `topicSlugSql`, so both range over the SAME
 * post set TrendingService counts. It is one `toLowerCase()` — too trivial to
 * look worth pinning, which is exactly why it is: a topic page that silently
 * returns nothing because one side lowercased and the other did not is the
 * failure this module was created to end.
 */
describe('normalizeTopicSlug', () => {
  it('lowercases mixed-case and already-lowercase slugs identically', () => {
    expect(normalizeTopicSlug('BasketBall')).toBe(normalizeTopicSlug('basketball'));
    expect(normalizeTopicSlug('Tech')).toBe('tech');
  });

  it('leaves an already-normalized slug untouched', () => {
    expect(normalizeTopicSlug('tech')).toBe('tech');
  });
});
