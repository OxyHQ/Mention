// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

const mockError = jest.fn();
jest.mock('@oxy.so/core/logger', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mockError(...args) }),
}));

import { handleLanguageError } from '../handleLanguageError';

/**
 * `OxyProvider`'s `language` config reports a failed `onChange` here instead
 * of throwing into render — a missing catalog chunk for the resolved locale
 * must not take the whole app tree down over a chrome-language mismatch.
 */
describe('handleLanguageError', () => {
  beforeEach(() => {
    mockError.mockClear();
  });

  it('logs the failure with the locale that failed to load, never throws', () => {
    const failure = new Error('missing catalog chunk');

    expect(() => handleLanguageError(failure, 'es-ES')).not.toThrow();
    expect(mockError).toHaveBeenCalledWith('Failed to follow the Oxy-resolved language', failure, {
      locale: 'es-ES',
    });
  });
});
