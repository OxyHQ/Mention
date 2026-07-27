import { describe, expect, it } from 'vitest';
import {
  getValidatedFeedSource,
  isExpensiveFeedRequest,
} from '../../middleware/feedThrottleDescriptor';

function request(query: Record<string, unknown>) {
  return { query } as Parameters<typeof getValidatedFeedSource>[0];
}

describe('feed throttle descriptor classification', () => {
  it('classifies expensive MTN descriptors by their validated source', () => {
    expect(getValidatedFeedSource(request({ descriptor: 'for_you' }))).toBe('for_you');
    expect(getValidatedFeedSource(request({ descriptor: 'explore' }))).toBe('explore');
    expect(isExpensiveFeedRequest(request({ descriptor: 'for_you' }))).toBe(true);
  });

  it('normalizes parameterized descriptors instead of keying on raw input', () => {
    expect(getValidatedFeedSource(request({ descriptor: 'author|user-123|posts' }))).toBe('author');
    expect(isExpensiveFeedRequest(request({ descriptor: 'author|user-123|posts' }))).toBe(false);
  });

  it('ignores retired type parameters that the feed controller does not accept', () => {
    expect(getValidatedFeedSource(request({ type: 'for_you' }))).toBeUndefined();
    expect(isExpensiveFeedRequest(request({ type: 'for_you' }))).toBe(false);
  });

  it('does not let malformed descriptor fall through to a conflicting parameter', () => {
    const malformed = request({
      descriptor: ['following'],
      type: 'for_you',
    });

    expect(getValidatedFeedSource(malformed)).toBeUndefined();
    expect(isExpensiveFeedRequest(malformed)).toBe(false);
  });

  it('rejects unknown sources', () => {
    expect(getValidatedFeedSource(request({ descriptor: 'not-a-feed' }))).toBeUndefined();
    expect(isExpensiveFeedRequest(request({ descriptor: 'not-a-feed' }))).toBe(false);
  });
});
