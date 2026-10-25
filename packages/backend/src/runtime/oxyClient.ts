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
      serviceIdentity: 'when-anonymous',
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
