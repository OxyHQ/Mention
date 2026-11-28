// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffDelayMs } from '../../utils/backoff';
import { sleep } from '../../utils/sleep';

describe('backoffDelayMs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('doubles per attempt and adds jitter below the ratio', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffDelayMs(0, { baseMs: 1000 })).toBe(1000);
    expect(backoffDelayMs(3, { baseMs: 1000 })).toBe(8000);
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(backoffDelayMs(1, { baseMs: 1000, jitter: 0.2 })).toBe(2399);
  });

  it('caps the exponential part before jitter', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(backoffDelayMs(20, { baseMs: 1000, maxMs: 30_000 })).toBe(30_000);
  });
});

describe('sleep', () => {
  it('rejects with the abort reason and not after the timer', async () => {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
    await expect(sleep(1, controller.signal)).rejects.toThrow('stop');
  });

  it('resolves when not aborted', async () => {
    await expect(sleep(1, new AbortController().signal)).resolves.toBeUndefined();
  });
});
