import { describe, expect, it } from 'vitest';
import { PostVisibility } from '@mention/shared-types';
import { isSubscriberNotificationEligible } from '../../services/PostCreationService';

describe('PostCreationService subscriber notification eligibility', () => {
  it.each([
    ['draft public post', 'draft', PostVisibility.PUBLIC],
    ['private published post', 'published', PostVisibility.PRIVATE],
    ['followers-only published post', 'published', PostVisibility.FOLLOWERS_ONLY],
  ] as const)('does not announce a %s', (_label, status, visibility) => {
    expect(isSubscriberNotificationEligible({ status, visibility })).toBe(false);
  });

  it('announces a published public post', () => {
    expect(isSubscriberNotificationEligible({
      status: 'published',
      visibility: PostVisibility.PUBLIC,
    })).toBe(true);
  });
});
