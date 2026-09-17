/**
 * The podcast save client talks to Syra's ORIGIN (the SDK adds `/api` itself,
 * while `SYRA_API_URL` already ends in it) and authenticates as the Oxy viewer
 * on every request, reading the token at call time rather than at creation.
 */

import type { SyraClient } from '@syra.fm/sdk';
import { buildSyraClient } from '../syraPodcasts';

let mockToken: string | null = 'token-1';

jest.mock('@/config', () => ({ SYRA_API_URL: 'https://api.syra.fm/api' }));
jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { getClient: () => ({ getAccessToken: () => mockToken }) },
}));

type Options = { baseURL: string; getAccessToken: () => string | null };

it('builds the client against the Syra origin, with the live Oxy token', () => {
  const createSyraClient = jest.fn((options: Options) => ({ options }) as unknown as SyraClient);
  buildSyraClient({ createSyraClient } as never);

  const options = createSyraClient.mock.calls[0][0];
  expect(options.baseURL).toBe('https://api.syra.fm');
  expect(options.getAccessToken()).toBe('token-1');
  mockToken = 'token-2';
  expect(options.getAccessToken()).toBe('token-2');
});
