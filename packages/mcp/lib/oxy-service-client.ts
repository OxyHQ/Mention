import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

/** The MCP process proves its infrastructure role; customer keys are never a fallback. */
export function oxyServiceClient(config: { readonly oxyApiUrl: string }): OxyServer {
  return new OxyServer({
    baseURL: config.oxyApiUrl,
    serviceIdentity: 'when-anonymous',
    workloadCredentials: createAwsWorkloadCredentialProvider(),
  });
}
