// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'vitest';
import {
  ANON_FRESH_MS,
  ANON_KEEP_SECONDS,
  anonFreshMsFor,
  anonKeepSecondsFor,
} from '../../services/feed/anonFeedFreshness';

describe('anonFreshMsFor', () => {
  it('keeps Explore, whose build reads ~45,000 blocks, fresh longer than any other anonymous page', () => {
    expect(anonFreshMsFor('explore')).toBe(5 * 60 * 1000);
    expect(anonFreshMsFor('explore')).toBeGreaterThan(ANON_FRESH_MS);
  });

  it('leaves every other descriptor on the default window', () => {
    for (const descriptor of ['for_you', 'media', 'videos', 'author|u1', 'hashtag|news']) {
      expect(anonFreshMsFor(descriptor)).toBe(ANON_FRESH_MS);
    }
  });
});

describe('anonKeepSecondsFor', () => {
  it("keeps Explore's first page a day, so a language nobody read for 15 minutes is never empty", () => {
    expect(anonKeepSecondsFor('explore', undefined)).toBe(24 * 60 * 60);
  });

  it("keeps an Explore cursor page, which belongs to one reader's session, only the default time", () => {
    expect(anonKeepSecondsFor('explore', 'cursor-1')).toBe(ANON_KEEP_SECONDS);
  });

  it('keeps every other page the default time, still far longer than it is fresh', () => {
    for (const descriptor of ['for_you', 'media', 'videos', 'author|u1', 'hashtag|news']) {
      expect(anonKeepSecondsFor(descriptor, undefined)).toBe(ANON_KEEP_SECONDS);
    }
    expect(ANON_KEEP_SECONDS * 1000).toBeGreaterThan(anonFreshMsFor('explore'));
  });
});
