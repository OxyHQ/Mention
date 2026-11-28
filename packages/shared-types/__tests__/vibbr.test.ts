// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import { sanitizeVibbrEvent, vibbrEventFromText } from '../src/vibbr';

const ID = `evt_${'a'.repeat(24)}`;

describe('Vibbr references', () => {
  it('keeps only a validated opaque ID', () => {
    expect(sanitizeVibbrEvent({ eventId: ID, title: 'Not ours', venue: 'private' })).toEqual({
      eventId: ID,
    });
    for (const value of [null, {}, { eventId: '' }, { eventId: 1 }, { eventId: 'evt_x' }])
      expect(sanitizeVibbrEvent(value)).toBeUndefined();
  });
  it('extracts a reference from a pasted canonical URL with punctuation', () => {
    expect(vibbrEventFromText(`Tickets here (https://vibbr.co/e/${ID}).`)).toEqual({
      eventId: ID,
    });
    for (const text of [
      `https://evil.test/e/${ID}`,
      `https://vibbr.co.evil.test/e/${ID}`,
      `http://vibbr.co/e/${ID}`,
      `https://user@vibbr.co/e/${ID}`,
    ])
      expect(vibbrEventFromText(text)).toBeUndefined();
  });
});
