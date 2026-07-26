import type { OxyServices } from '@oxyhq/core';
import { config } from '../config';

/**
 * Runtime seam for the process-wide Oxy client.
 *
 * Domain modules resolve the client here instead of importing the server
 * entrypoint. The lazy fallback keeps isolated scripts and unit tests usable
 * without booting Express; runtimeApp.ts registers the process-owned instance
 * while composing production dependencies.
 */
let runtimeOxyClient: OxyServices | undefined;

export function setRuntimeOxyClient(client: OxyServices): void {
  runtimeOxyClient = client;
}

export function getRuntimeOxyClient(): OxyServices {
  if (!runtimeOxyClient) {
    // Lazy require keeps importing domain modules side-effect free. Isolated
    // tests and scripts that inject a client never load the full Oxy runtime.
    const { OxyServices: OxyServicesConstructor } = require('@oxyhq/core') as {
      OxyServices: new (options: { baseURL: string }) => OxyServices;
    };
    runtimeOxyClient = new OxyServicesConstructor({ baseURL: config.oxyApiUrl });
  }
  return runtimeOxyClient;
}

/** Test/lifecycle hook; production shutdown normally ends the process. */
export function clearRuntimeOxyClient(): void {
  runtimeOxyClient = undefined;
}
