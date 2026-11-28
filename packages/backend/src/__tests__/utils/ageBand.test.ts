// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'vitest';
import { ageBandOf } from '../../utils/ageBand';

/**
 * The age band is read off whatever Oxy answered for the session, so only a
 * known band counts and everything else is "unknown".
 */
describe('ageBandOf', () => {
  it.each(['under13', 'teen', 'adult'] as const)('reads %s', (band) => {
    expect(ageBandOf({ ageBand: band })).toBe(band);
  });

  it('reads no band from a user without one, or no user at all', () => {
    expect(ageBandOf({})).toBeUndefined();
    expect(ageBandOf(undefined)).toBeUndefined();
    expect(ageBandOf(null)).toBeUndefined();
  });

  it('reads no band from a value it does not know', () => {
    expect(ageBandOf({ ageBand: 'senior' })).toBeUndefined();
    expect(ageBandOf({ ageBand: 15 })).toBeUndefined();
    expect(ageBandOf({ ageBand: true })).toBeUndefined();
  });
});
