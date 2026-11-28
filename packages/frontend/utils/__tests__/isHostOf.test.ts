// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { isHostOf } from '../isHostOf';

describe('isHostOf', () => {
  it('accepts the domain itself', () => {
    expect(isHostOf('spotify.com', 'spotify.com')).toBe(true);
  });

  it('accepts a subdomain', () => {
    expect(isHostOf('open.spotify.com', 'spotify.com')).toBe(true);
    expect(isHostOf('m.youtube.com', 'youtube.com')).toBe(true);
  });

  it('rejects a lookalike that only shares the suffix', () => {
    expect(isHostOf('notspotify.com', 'spotify.com')).toBe(false);
    expect(isHostOf('evil-syra.fm', 'syra.fm')).toBe(false);
  });

  it('rejects the domain appearing anywhere but the end', () => {
    expect(isHostOf('spotify.com.attacker.net', 'spotify.com')).toBe(false);
  });
});
