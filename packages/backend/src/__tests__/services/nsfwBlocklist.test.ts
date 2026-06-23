import { describe, expect, it } from 'vitest';

import { NSFW_HASHTAGS, isNsfwHashtag, isSensitivePost } from '../../services/contentClassification/nsfw';

/**
 * Unit coverage for the canonical NSFW/adult hashtag blocklist. Verifies the
 * normalization contract (case, leading `#`, whitespace, nullish) so every
 * discovery consumer (trending today, For You / Explore later) gets consistent
 * results from the single source of truth.
 */
describe('isNsfwHashtag', () => {
  it('matches blocklisted slugs regardless of case', () => {
    expect(isNsfwHashtag('nsfw')).toBe(true);
    expect(isNsfwHashtag('NSFW')).toBe(true);
    expect(isNsfwHashtag('Sexy')).toBe(true);
    expect(isNsfwHashtag('OnlyFans')).toBe(true);
  });

  it('normalizes a leading # and surrounding whitespace', () => {
    expect(isNsfwHashtag('#porn')).toBe(true);
    expect(isNsfwHashtag('  #Hentai  ')).toBe(true);
  });

  it('returns false for clean hashtags', () => {
    expect(isNsfwHashtag('tech')).toBe(false);
    expect(isNsfwHashtag('art')).toBe(false);
    expect(isNsfwHashtag('science')).toBe(false);
  });

  it('returns false for nullish or empty input', () => {
    expect(isNsfwHashtag(null)).toBe(false);
    expect(isNsfwHashtag(undefined)).toBe(false);
    expect(isNsfwHashtag('')).toBe(false);
    expect(isNsfwHashtag('   ')).toBe(false);
  });

  it('exposes the blocklist as a non-empty Set', () => {
    expect(NSFW_HASHTAGS.size).toBeGreaterThan(0);
    expect(NSFW_HASHTAGS.has('nsfw')).toBe(true);
  });
});

describe('isSensitivePost', () => {
  it('is false (neutral) for a clean post and nullish input', () => {
    expect(isSensitivePost(null)).toBe(false);
    expect(isSensitivePost(undefined)).toBe(false);
    expect(isSensitivePost({})).toBe(false);
    expect(isSensitivePost({ hashtags: ['tech', 'art'] })).toBe(false);
    expect(isSensitivePost({ postClassification: { sensitive: false } })).toBe(false);
  });

  it('is true when the classifier flagged it sensitive', () => {
    expect(isSensitivePost({ postClassification: { sensitive: true } })).toBe(true);
  });

  it('is true when app metadata marks it sensitive', () => {
    expect(isSensitivePost({ metadata: { isSensitive: true } })).toBe(true);
  });

  it('is true when the federating source flagged it sensitive', () => {
    expect(isSensitivePost({ federation: { sensitive: true } })).toBe(true);
  });

  it('is true when it carries an NSFW/adult hashtag (any case)', () => {
    expect(isSensitivePost({ hashtags: ['nsfw'] })).toBe(true);
    expect(isSensitivePost({ hashtags: ['tech', 'NSFW'] })).toBe(true);
    expect(isSensitivePost({ hashtags: ['onlyfans'] })).toBe(true);
  });
});
