// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import { canUseCommunities } from '../src/community';

describe('canUseCommunities', () => {
  it('admits only the preview handles, whatever their case or spacing', () => {
    expect(canUseCommunities('oxy')).toBe(true);
    expect(canUseCommunities(' Nate ')).toBe(true);
    expect(canUseCommunities('nathan')).toBe(false);
    expect(canUseCommunities('')).toBe(false);
    expect(canUseCommunities(null)).toBe(false);
    expect(canUseCommunities(undefined)).toBe(false);
  });
});
