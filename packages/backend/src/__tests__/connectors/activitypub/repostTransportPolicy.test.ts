// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import {
  dropsFlattenedReposts,
  REVIEWED_REPOST_TRANSPORT_HOSTS,
} from '../../../connectors/activitypub/repostTransportPolicy';
describe('reviewed content transports', () => {
  it('preserves the historical RT gate without account or profile derivation', () => {
    for (const host of REVIEWED_REPOST_TRANSPORT_HOSTS)
      expect(dropsFlattenedReposts(host)).toBe(true);
    expect(dropsFlattenedReposts(' BIRD.MAKEUP ')).toBe(true);
    expect(dropsFlattenedReposts('bird.makeup.evil.example')).toBe(false);
    expect(dropsFlattenedReposts('threads.net')).toBe(false);
    expect(dropsFlattenedReposts('mastodon.social')).toBe(false);
  });
});
