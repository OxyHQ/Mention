/** The product factory owns session changes and refresh; callers never copy a bearer. */
import type { SyraClient } from '@syra.fm/sdk/client';
import { buildSyraClient, getSyraClient } from '../syraPodcasts';
import { oxyServices } from '@/lib/oxyServices';
jest.mock('@/config', () => ({ SYRA_API_URL: 'https://api.syra.fm/api' }));
jest.mock('@/lib/oxyServices', () => ({ oxyServices: { createLinkedClient: jest.fn() } }));
it('binds the Syra origin to the existing Oxy session owner', () => {
  const syraForOxySession = jest.fn(
    (_oxy: unknown, _options: unknown) => ({ dispose() {} }) as SyraClient & { dispose(): void },
  );
  buildSyraClient({ syraForOxySession });
  expect(syraForOxySession).toHaveBeenCalledWith(oxyServices, { baseURL: 'https://api.syra.fm' });
});

const mockSessionClient = { dispose: jest.fn() };
const mockSessionFactory = jest.fn((_oxy: unknown, _options: unknown) => mockSessionClient);
jest.mock('@syra.fm/sdk/client', () => ({
  syraForOxySession: (oxy: unknown, options: unknown) => mockSessionFactory(oxy, options),
}));
it('loads one session-bound client lazily and shares it between concurrent callers', async () => {
  expect(mockSessionFactory).not.toHaveBeenCalled();
  const first = getSyraClient();
  const concurrent = getSyraClient();
  expect(concurrent).toBe(first);
  expect(await first).toBe(mockSessionClient);
  expect(await getSyraClient()).toBe(mockSessionClient);
  expect(mockSessionFactory).toHaveBeenCalledTimes(1);
  expect(mockSessionFactory).toHaveBeenCalledWith(oxyServices, { baseURL: 'https://api.syra.fm' });
});
