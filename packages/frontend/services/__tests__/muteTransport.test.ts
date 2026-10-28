jest.mock('@/lib/oxyServices', () => {
  const { OxyServices } = jest.requireActual<typeof import('@oxy.so/core')>('@oxy.so/core');
  return { oxyServices: new OxyServices({ baseURL: 'https://oxy.fixture.invalid' }) };
});
jest.mock('@/config', () => ({ API_URL: 'https://mention.fixture.invalid' }));
jest.mock('@/lib/i18n', () => ({ __esModule: true, default: { language: 'en' } }));
jest.mock('@oxy.so/services/ui/client', () => ({ useAuthStore: {} }));
jest.mock('@/stores/feedRankingInvalidation', () => ({ notifyFeedRankingChanged: jest.fn() }));

import type { MutedUsersResponse } from '@mention/shared-types';
import { muteService } from '../muteService';

// Exercise the published SDK and utils/api. Mock only the HTTP boundary, with
// the JSON emitted by GET /mute (not an invented Axios or nested data envelope).
afterEach(() => jest.restoreAllMocks());

it('returns canonical mute records without retaining a previous viewer response', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch');
  for (const userId of ['viewer-a', 'viewer-b']) {
    const payload: MutedUsersResponse = {
      mutes: [
        { _id: `mute-${userId}`, userId, mutedId: 'target', createdAt: '2026-10-28T00:00:00.000Z' },
      ],
      count: 1,
    };
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(muteService.getMutedUsers()).resolves.toEqual(payload.mutes);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [url] of fetch.mock.calls)
    expect(String(url)).toBe('https://mention.fixture.invalid/mute');
});

it('returns an empty canonical list and preserves the existing error fallback', async () => {
  const fetch = jest.spyOn(globalThis, 'fetch');
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ mutes: [], count: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await expect(muteService.getMutedUsers()).resolves.toEqual([]);
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ message: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  await expect(muteService.getMutedUsers()).resolves.toEqual([]);
  fetch.mockRejectedValueOnce(new Error('offline'));
  await expect(muteService.getMutedUsers()).resolves.toEqual([]);
});
