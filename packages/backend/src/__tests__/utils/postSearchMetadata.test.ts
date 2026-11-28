// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import { postTextHasHttpLink } from '../../utils/postSearchMetadata';

describe('postTextHasHttpLink', () => {
  it('checks every localized variant without treating arbitrary text as a link', () => {
    expect(
      postTextHasHttpLink([{ text: 'sin enlace' }, { text: 'See HTTPS://example.com/docs' }]),
    ).toBe(true);
    expect(postTextHasHttpLink([{ text: 'example.com is plain text' }])).toBe(false);
    expect(postTextHasHttpLink(undefined)).toBe(false);
  });
});
