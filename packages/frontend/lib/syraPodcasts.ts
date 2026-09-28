import type { SyraClient } from '@syra.fm/sdk/client';
import { oxyServices } from '@/lib/oxyServices';
import { SYRA_API_URL } from '@/config';

/**
 * The Syra SDK client for podcast library writes, authenticated as the Oxy
 * viewer.
 *
 * Loaded on first use, never at module scope, and from `@syra.fm/sdk/client`:
 * the SDK's root entry also carries the LiveKit rooms engine on web and native.
 * That engine has its own single async boundary (`LiveFeatureProviders`); a
 * second `import()` of the root here made Metro share it between two chunks and
 * hoist LiveKit and the rooms UI into `__common`, which every page downloads.
 *
 * `SYRA_API_URL` is the rooms client's base and ends in `/api`; the SDK takes
 * the origin and adds `/api` itself.
 */
let clientPromise: Promise<SyraClient> | null = null;

type SyraSdk = Pick<typeof import('@syra.fm/sdk/client'), 'createSyraClient'>;

/** The client for a loaded SDK. Split out so it is testable without a dynamic import. */
export function buildSyraClient({ createSyraClient }: SyraSdk): SyraClient {
  return createSyraClient({
    baseURL: SYRA_API_URL.replace(/\/api\/?$/, ''),
    getAccessToken: () => oxyServices.http.getAccessToken(),
  });
}

export function getSyraClient(): Promise<SyraClient> {
  clientPromise ??= import('@syra.fm/sdk/client').then(buildSyraClient);
  return clientPromise;
}
