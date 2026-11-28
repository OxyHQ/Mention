// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config', () => ({ getKlipyAppKey: () => 'key' }));

import { getTrendingGifs, searchGifs } from '../../services/media/gifService';

const params = { page: 2, perPage: 5, customerId: 'c1' };

afterEach(() => vi.unstubAllGlobals());

describe('gifService', () => {
  it('calls Klipy with its parameters and a deadline', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: true, data: { data: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    await searchGifs({ ...params, query: 'cat' });
    await getTrendingGifs(params);

    const calls = fetchMock.mock.calls as unknown as [URL, RequestInit][];
    expect(calls[0][0].pathname).toBe('/api/v1/key/gifs/search');
    expect(calls[0][0].searchParams.get('q')).toBe('cat');
    expect(calls[1][0].pathname).toBe('/api/v1/key/gifs/trending');
    expect(calls[1][0].searchParams.get('per_page')).toBe('5');
    for (const [, init] of calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects a non-2xx answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 502 })),
    );
    await expect(getTrendingGifs(params)).rejects.toThrow('KLIPY API error: 502');
  });
});
