import { describe, expect, it } from 'vitest';

import {
  isSensitivePost,
  isSfw,
  isDiscoverable,
  filterDiscoverable,
} from '../mtn/feed/feedSafety';

/**
 * Unit coverage for the SINGLE shared feed-safety module. Every feed/ranking
 * surface imports this predicate, so this is the one place the gating definition
 * is verified.
 */
describe('feedSafety — isSensitivePost / isSfw', () => {
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

  it('isSfw / isDiscoverable are the exact inverse of isSensitivePost', () => {
    const clean = { hashtags: ['tech'] };
    const dirty = { hashtags: ['nsfw'] };
    expect(isSfw(clean)).toBe(true);
    expect(isSfw(dirty)).toBe(false);
    // isDiscoverable is the intent-revealing alias of isSfw.
    expect(isDiscoverable).toBe(isSfw);
    expect(isDiscoverable(clean)).toBe(true);
    expect(isDiscoverable(dirty)).toBe(false);
  });
});

describe('feedSafety — filterDiscoverable', () => {
  it('keeps only SFW posts and preserves order', () => {
    const posts = [
      { _id: '1', hashtags: ['tech'] },
      { _id: '2', hashtags: ['nsfw'] },
      { _id: '3', postClassification: { sensitive: true } },
      { _id: '4', metadata: { isSensitive: true } },
      { _id: '5', federation: { sensitive: true } },
      { _id: '6', hashtags: ['art'] },
    ];
    expect(filterDiscoverable(posts).map((p) => p._id)).toEqual(['1', '6']);
  });

  it('returns an empty array unchanged', () => {
    expect(filterDiscoverable([])).toEqual([]);
  });
});
