// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { canAutoLoadFeed, showsCaughtUp } from '../feedPaging';

/**
 * A feed that loads on request (a minor's account, oxy ADR 0068) never fetches
 * its next page because the reader reached the end of the list.
 */
describe('canAutoLoadFeed', () => {
  const ready = { hasMore: true, isLoading: false };

  it('loads by itself on an ordinary feed with more to show', () => {
    expect(canAutoLoadFeed({ ...ready, loadsOnRequest: false })).toBe(true);
  });

  it('never loads by itself on a feed that loads on request', () => {
    expect(canAutoLoadFeed({ ...ready, loadsOnRequest: true })).toBe(false);
  });

  it('keeps every other reason not to load', () => {
    expect(canAutoLoadFeed({ hasMore: false, isLoading: false, loadsOnRequest: false })).toBe(
      false,
    );
    expect(canAutoLoadFeed({ hasMore: true, isLoading: true, loadsOnRequest: false })).toBe(false);
    expect(canAutoLoadFeed({ ...ready, previewLimit: 5, loadsOnRequest: false })).toBe(false);
  });
});

describe('showsCaughtUp', () => {
  it.each(['for_you', 'following', 'mutuals'])('is said at the end of %s', (descriptor) => {
    expect(showsCaughtUp(descriptor)).toBe(true);
  });

  it.each(['author|someone', 'hashtag|cats', 'explore', 'saved', 'trend|cats|top', 'custom|1'])(
    'is not said at the end of %s',
    (descriptor) => {
      expect(showsCaughtUp(descriptor)).toBe(false);
    },
  );
});
