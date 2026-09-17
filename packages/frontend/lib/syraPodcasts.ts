import type { SyraClient } from '@syra.fm/sdk';
import { oxyServices } from '@/lib/oxyServices';
import { SYRA_API_URL } from '@/config';

/**
 * The Syra SDK client for podcast library writes, authenticated as the Oxy
 * viewer.
 *
 * Loaded on first use, never at module scope: on web and native the SDK's root
 * entry also exports the LiveKit rooms engine, and a static import from a feed
 * card would pull that into the main bundle for every reader (see
 * `LiveFeatureProviders`, which defers it for the same reason).
 *
 * `SYRA_API_URL` is the rooms client's base and ends in `/api`; the SDK takes
 * the origin and adds `/api` itself.
 */
let clientPromise: Promise<SyraClient> | null = null;

type SyraSdk = Pick<typeof import('@syra.fm/sdk'), 'createSyraClient'>;

/** The client for a loaded SDK. Split out so it is testable without a dynamic import. */
export function buildSyraClient({ createSyraClient }: SyraSdk): SyraClient {
  return createSyraClient({
    baseURL: SYRA_API_URL.replace(/\/api\/?$/, ''),
    getAccessToken: () => oxyServices.getClient().getAccessToken(),
  });
}

export function getSyraClient(): Promise<SyraClient> {
  clientPromise ??= import('@syra.fm/sdk').then(buildSyraClient);
  return clientPromise;
}
