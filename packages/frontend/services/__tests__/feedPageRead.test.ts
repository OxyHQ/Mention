// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { feedService } from '@/services/feedService';
import { __feedPageReadForTests, startBootFeedRead, takeBootFeedRead } from '../feedPageRead';

jest.mock('@/services/feedService', () => ({
  feedService: { getFeed: jest.fn(), getUserFeed: jest.fn() },
}));

const getFeed = feedService.getFeed as jest.Mock;
const forYou = { type: 'for_you' as const };

describe('the boot read of the home feed', () => {
  beforeEach(() => {
    __feedPageReadForTests.reset();
    getFeed.mockReset().mockResolvedValue({ items: [], hasMore: false });
  });

  it('is taken only by the viewer it was read as, and only once', async () => {
    startBootFeedRead('viewer-a');
    expect(getFeed).toHaveBeenCalledTimes(1);

    // Another viewer resolved: never served, and the read is retired.
    expect(takeBootFeedRead({ ...forYou, viewerId: 'viewer-b' }, undefined)).toBeNull();
    expect(takeBootFeedRead({ ...forYou, viewerId: 'viewer-a' }, undefined)).toBeNull();

    __feedPageReadForTests.reset();
    startBootFeedRead(null);
    expect(takeBootFeedRead({ ...forYou, viewerId: 'viewer-a' }, 'cursor-2')).toBeNull();
    await expect(takeBootFeedRead(forYou, undefined)).resolves.toEqual({
      items: [],
      hasMore: false,
    });
    // Once the home feed has asked, a late boot read would be a second request.
    startBootFeedRead(null);
    expect(getFeed).toHaveBeenCalledTimes(2);
  });
});
