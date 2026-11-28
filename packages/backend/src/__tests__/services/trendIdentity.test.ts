// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import { groupRowsByPresentedName } from '../../services/trending/trendIdentity';

describe('groupRowsByPresentedName — one name, one row', () => {
  it('groups rows labelled the same name, whatever their casing or punctuation', () => {
    const groups = groupRowsByPresentedName([
      { term: 'chinese', displayName: 'Jensen Huang', volume: 39 },
      { term: 'jensen huang', displayName: 'jensen-huang', volume: 18 },
      { term: 'ceo', displayName: 'Chinese spy', volume: 34 },
    ]);

    expect(groups).toEqual([['chinese', 'jensen huang']]);
  });

  it('leaves distinct names alone', () => {
    expect(
      groupRowsByPresentedName([
        { term: 'huang', displayName: 'Huang', volume: 10 },
        { term: 'jensen huang', displayName: 'Jensen Huang', volume: 18 },
      ]),
    ).toEqual([]);
  });
});
