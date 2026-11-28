// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import { PostVisibility } from '@mention/shared-types';
import { isSubscriberNotificationEligible } from '../../services/posts/PostCreationService';

describe('PostCreationService subscriber notification eligibility', () => {
  it.each([
    ['draft public post', 'draft', PostVisibility.PUBLIC],
    ['private published post', 'published', PostVisibility.PRIVATE],
    ['followers-only published post', 'published', PostVisibility.FOLLOWERS_ONLY],
  ] as const)('does not announce a %s', (_label, status, visibility) => {
    expect(isSubscriberNotificationEligible({ status, visibility })).toBe(false);
  });

  it('announces a published public post', () => {
    expect(
      isSubscriberNotificationEligible({
        status: 'published',
        visibility: PostVisibility.PUBLIC,
      }),
    ).toBe(true);
  });
});
