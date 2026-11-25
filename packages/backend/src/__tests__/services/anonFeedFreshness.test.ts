import { describe, expect, it } from 'vitest';
import { ANON_FRESH_MS, anonFreshMsFor } from '../../services/anonFeedFreshness';

describe('anonFreshMsFor', () => {
  it('keeps Explore, whose build reads ~45,000 blocks, fresh longer than any other anonymous page', () => {
    expect(anonFreshMsFor('explore')).toBe(5 * 60 * 1000);
    expect(anonFreshMsFor('explore')).toBeGreaterThan(ANON_FRESH_MS);
  });

  it('leaves every other descriptor on the default window', () => {
    for (const descriptor of ['for_you', 'media', 'videos', 'author|u1', 'hashtag|news']) {
      expect(anonFreshMsFor(descriptor)).toBe(ANON_FRESH_MS);
    }
  });
});
