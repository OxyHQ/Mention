import type { OxyServer } from '@oxy.so/core/server';
import { config } from '../config';

/**
 * Runtime seam for the process-wide Oxy client.
 *
 * Domain modules resolve the client here instead of importing the server
 * entrypoint. The lazy fallback keeps isolated scripts and unit tests usable
 * without booting Express; runtimeApp.ts registers the process-owned instance
 * while composing production dependencies.
 */
let runtimeOxyClient: OxyServer | undefined;

export function setRuntimeOxyClient(client: OxyServer): void {
  runtimeOxyClient = client;
}

export function getRuntimeOxyClient(): OxyServer {
  if (!runtimeOxyClient) {
    // Lazy require keeps importing domain modules side-effect free. Isolated
    // tests and scripts that inject a client never load the full Oxy runtime.
    const { OxyServer: OxyServerConstructor } = require('@oxy.so/core/server') as {
      OxyServer: typeof OxyServer;
    };
    // Same identity as the production instance in runtimeApp.ts (#1173).
    runtimeOxyClient = new OxyServerConstructor({ baseURL: config.oxyApiUrl, serviceIdentity: 'when-anonymous' });
  }
  return runtimeOxyClient;
}

/** Test/lifecycle hook; production shutdown normally ends the process. */
export function clearRuntimeOxyClient(): void {
  runtimeOxyClient = undefined;
}
