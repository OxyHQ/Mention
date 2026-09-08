import { describe, expect, it } from 'vitest';
import { scoreContextualStoryMembership, scoreStoryMembership } from '../../services/trending/storyMembership';

describe('deterministic story membership', () => {
  it('keeps the representative term authoritative', () => {
    expect(scoreStoryMembership('trump', ['trump', 'white house'], ['trump']).relevance)
      .toBeGreaterThanOrEqual(0.5);
  });

  it('rejects an incidental weak member on its own', () => {
    expect(scoreStoryMembership('trump', ['trump', 'white house'], ['white house']).relevance)
      .toBeLessThan(0.5);
  });

  it('accepts a post carrying the coherent story together', () => {
    const result = scoreStoryMembership(
      'trump',
      ['trump', 'white house'],
      ['fanta', 'trump', 'white house'],
    );
    expect(result.relevance).toBe(1);
    expect(result.matchedTerms).toEqual(['trump', 'white house']);
  });

  it('does not admit a singleton story when the term is absent', () => {
    expect(scoreStoryMembership('oil', ['oil'], ['fanta']).relevance).toBe(0);
  });
});

describe('scoreContextualStoryMembership', () => {
  it('lets links and quoted posts corroborate an author-written match', () => {
    expect(scoreContextualStoryMembership({
      storyName: 'trump',
      storyTerms: ['trump', 'white house'],
      trendTerms: ['trump'],
      hashtags: [],
      linkTitleTerms: ['white house'],
      quotedTerms: ['trump'],
    })).toEqual({
      relevance: 1,
      matchedTerms: ['trump', 'white house'],
      sources: ['author-term', 'link-title', 'quoted-post'],
    });
  });

  it('never admits an unrelated post from link metadata alone', () => {
    expect(scoreContextualStoryMembership({
      storyName: 'trump',
      storyTerms: ['trump', 'white house'],
      trendTerms: ['fanta'],
      hashtags: [],
      linkTitleTerms: ['trump', 'white house'],
    })).toEqual({ relevance: 0, matchedTerms: [], sources: [] });
  });
});
