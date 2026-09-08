import { describe, expect, it } from 'vitest';
import { scoreStoryMembership } from '../../services/trending/storyMembership';

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
