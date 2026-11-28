import type { ClarityClient } from '@clarity.surf/sdk' with { 'resolution-mode': 'import' };

import { config } from '../config';
import { getServiceOxyClient } from './oxyHelpers';

let client: Promise<ClarityClient> | undefined;

export function getClarityClient(): Promise<ClarityClient> {
  if (client) return client;
  client = import('@clarity.surf/sdk/server').then(({ clarityForOxyService }) =>
    clarityForOxyService(getServiceOxyClient(), { baseUrl: config.clarityApiUrl }),
  );
  return client;
}
