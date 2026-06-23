import { describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for {@link buildPostsByTopicFilter} — the topic-page query the
 * `getPostsByTopic` controller runs. It must match a post whose CANONICAL
 * registry-linked `postClassification.topicRefs.name` OR slug-only
 * `postClassification.topics` equals the lowercased topic, always scoped to
 * `status: 'published'`.
 *
 * The controller pulls in the server bootstrap; stub it (and the OxyServices
 * client it constructs) so importing the controller stays pure/no-network.
 */
vi.mock('../../../server', () => ({
  oxy: {},
  io: { of: () => ({ emit: vi.fn() }) },
  notificationsNamespace: { emit: vi.fn() },
  roomsNamespace: { emit: vi.fn() },
}));

import { buildPostsByTopicFilter } from '../../controllers/posts.controller';

describe('buildPostsByTopicFilter — canonical topicRefs.name OR slug topics match', () => {
  it('matches the canonical topicRefs.name AND the slug-only postClassification.topics (lowercased)', () => {
    const filter = buildPostsByTopicFilter('Basketball');

    expect(filter.$or).toEqual([
      { 'postClassification.topicRefs.name': 'basketball' },
      { 'postClassification.topics': 'basketball' },
    ]);
    expect(filter.status).toBe('published');
    // No cursor → no _id range clause.
    expect(filter._id).toBeUndefined();
  });

  it('adds the cursor range clause when a cursor is provided', () => {
    const filter = buildPostsByTopicFilter('tech', 'cursor-123');
    expect(filter._id).toEqual({ $lt: 'cursor-123' });
    expect(filter.$or).toEqual([
      { 'postClassification.topicRefs.name': 'tech' },
      { 'postClassification.topics': 'tech' },
    ]);
  });
});
