// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import { homiioCaseFromText, sanitizeHomiioCase } from '../src/homiio';

describe('Homiio references', () => {
  it('keeps only a validated opaque ID', () => {
    expect(
      sanitizeHomiioCase({ caseId: 'opaque/a', title: 'Not ours', address: 'private' }),
    ).toEqual({ caseId: 'opaque/a' });
    for (const value of [null, {}, { caseId: '' }, { caseId: 1 }, { caseId: 'x'.repeat(201) }])
      expect(sanitizeHomiioCase(value)).toBeUndefined();
  });
  it('extracts a reference from a pasted canonical URL with punctuation', () => {
    expect(homiioCaseFromText('Help here (https://homiio.com/evictions/opaque%2Fa).')).toEqual({
      caseId: 'opaque/a',
    });
    for (const text of [
      'https://evil.test/evictions/a',
      'https://homiio.com.evil.test/evictions/a',
      'http://homiio.com/evictions/a',
      'https://user@homiio.com/evictions/a',
    ])
      expect(homiioCaseFromText(text)).toBeUndefined();
  });
});
