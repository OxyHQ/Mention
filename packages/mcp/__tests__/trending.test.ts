// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import { formatTrend } from '../tools/hashtags.js';

describe('trend formatter', () => {
  it('names a topic with its posts, people and languages, not the internal score', () => {
    expect(
      formatTrend(
        {
          type: 'entity',
          name: 'trump',
          displayName: 'Trump',
          volume: 22,
          authorCount: 9,
          languages: ['es', 'en'],
          score: 6.5,
        },
        0,
      ),
    ).toBe('1. Trump (topic, 22 posts by 9 people · es, en)');
  });

  it('marks a hashtag as one', () => {
    expect(formatTrend({ type: 'hashtag', name: 'brasil', volume: 1, authorCount: 1 }, 1)).toBe(
      '2. #brasil (hashtag, 1 post by 1 person)',
    );
  });

  it('copes with legacy shapes', () => {
    expect(formatTrend({ hashtag: '#fediverse', count: 3 }, 2)).toBe(
      '3. #fediverse (hashtag, 3 posts)',
    );
  });
});
