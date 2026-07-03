import { describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for {@link buildPostsByTopicFilter} — the topic-page query the
 * `getPostsByTopic` controller runs. It must match a post whose CANONICAL
 * registry-linked `postClassification.topicRefs.name` OR slug-only
 * `postClassification.topics` equals the lowercased topic, always scoped to
 * public, published posts so topic discovery cannot expose followers-only or
 * private content.
 *
 * The controller pulls in the server bootstrap; stub it (and the OxyServices
 * client it constructs) so importing the controller stays pure/no-network.
 */
vi.mock('../../../server', () => ({
  oxy: {},
  io: { of: () => ({ emit: vi.fn() }) },
  notificationsNamespace: { emit: vi.fn() },
}));

import { buildPostsByHashtagFilter, buildPostsByTopicFilter } from '../../controllers/posts.controller';

describe('buildPostsByTopicFilter — canonical topicRefs.name OR slug topics match', () => {
  it('matches the canonical topicRefs.name AND the slug-only postClassification.topics (lowercased)', () => {
    const filter = buildPostsByTopicFilter('Basketball');

    expect(filter.$or).toEqual([
      { 'postClassification.topicRefs.name': 'basketball' },
      { 'postClassification.topics': 'basketball' },
    ]);
    expect(filter.status).toBe('published');
    expect(filter.visibility).toBe('public');
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
    expect(filter.visibility).toBe('public');
  });
});

describe('buildPostsByHashtagFilter — hashtag discovery visibility scope', () => {
  it('matches normalized hashtags only on public, published posts', () => {
    const filter = buildPostsByHashtagFilter('MixedCase');

    expect(filter.hashtags).toEqual({ $in: ['mixedcase'] });
    expect(filter.status).toBe('published');
    expect(filter.visibility).toBe('public');
    expect(filter._id).toBeUndefined();
  });

  it('adds the cursor range clause without dropping ACL filters', () => {
    const filter = buildPostsByHashtagFilter('Tech', 'cursor-456');

    expect(filter._id).toEqual({ $lt: 'cursor-456' });
    expect(filter.status).toBe('published');
    expect(filter.visibility).toBe('public');
  });
});
