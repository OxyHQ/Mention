// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'bun:test';
import { handleKey, stripHandlePrefix } from '../src/handle';

describe('handle helpers', () => {
  it('strips every leading @ and whitespace, keeping case and any @host suffix', () => {
    expect(stripHandlePrefix(' @@Alice ')).toBe('Alice');
    expect(stripHandlePrefix('@alice@x.com')).toBe('alice@x.com');
    expect(stripHandlePrefix('alice')).toBe('alice');
  });

  it('compares handles case-insensitively', () => {
    expect(handleKey('@Alice')).toBe(handleKey('alice'));
  });
});
