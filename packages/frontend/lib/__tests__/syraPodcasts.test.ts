/** The product factory owns session changes and refresh; callers never copy a bearer. */
import type { SyraClient } from '@syra.fm/sdk/client';
import { buildSyraClient } from '../syraPodcasts';
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
