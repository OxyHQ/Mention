// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'vitest';
import { PostVisibility } from '@mention/shared-types';
import { mapApVisibility } from '../../../connectors/activitypub/helpers';

/**
 * The audience rule reads addressing in every JSON-LD form a server may send:
 * the public collection compacted to `as:Public` / `Public`, a single value in
 * place of a one-element array, and an embedded object in place of its IRI.
 * Read as Mastodon's plain arrays only, such a public note was taken for a
 * direct message to nobody here and dropped (or, already stored, hidden).
 */

const FOLLOWERS = 'https://remote.test/users/carol/followers';

describe('mapApVisibility', () => {
  it('reads every JSON-LD form of the public collection and of followers addressing', () => {
    for (const to of [
      ['https://www.w3.org/ns/activitystreams#Public'],
      'https://www.w3.org/ns/activitystreams#Public',
      ['as:Public'],
      'Public',
      [{ id: 'https://www.w3.org/ns/activitystreams#Public' }],
    ]) {
      expect(mapApVisibility(to, FOLLOWERS, FOLLOWERS)).toBe(PostVisibility.PUBLIC);
    }
    expect(mapApVisibility(FOLLOWERS, undefined, FOLLOWERS)).toBe(PostVisibility.FOLLOWERS_ONLY);
    expect(mapApVisibility({ id: FOLLOWERS }, [], FOLLOWERS)).toBe(PostVisibility.FOLLOWERS_ONLY);
    expect(mapApVisibility('https://mention.earth/ap/users/alice', undefined, FOLLOWERS)).toBe(
      PostVisibility.DIRECT,
    );
  });
});
