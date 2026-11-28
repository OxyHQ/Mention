import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { config } from '../config';
import { instrumentOxyEgress } from '../utils/oxyMetrics';

/** One workload client per process. Provider resolution and attestation are lazy. */
let runtimeOxyClient: OxyServer | undefined;
export function setRuntimeOxyClient(client: OxyServer): void {
  runtimeOxyClient = client;
}
export function getRuntimeOxyClient(): OxyServer {
  if (!runtimeOxyClient) {
    runtimeOxyClient = new OxyServer({
      baseURL: config.oxyApiUrl,
      applicationId: config.identity.serviceApplicationId,
      serviceIdentity: 'when-anonymous',
      // Every `middleware.auth()` / `service()` mount accepts service tokens
      // minted for Mention itself; named once here instead of at each mount.
      expectedAudience: `oxy-service:${config.identity.serviceApplicationId}`,
      workloadCredentials: createAwsWorkloadCredentialProvider(),
    });
    instrumentOxyEgress(runtimeOxyClient);
  }
  return runtimeOxyClient;
}
/** Test/lifecycle hook; no bearer is persisted. */
export function clearRuntimeOxyClient(): void {
  runtimeOxyClient = undefined;
}
