import { OxyServer } from '@oxy.so/core/server';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

/** What the MCP process's Oxy client is built from. */
export interface OxyServiceClientConfig {
  readonly oxyApiUrl: string;
  /** Mention's registered Oxy application, when the task names it. */
  readonly applicationId?: string;
}

/**
 * The MCP process's ONE `OxyServer`, built once by the process entry point
 * (`server-http.ts`) and handed to every call site — the token introspector,
 * the capability audit, the catalogue registration and the internal receiver —
 * so the process holds one service-token cache, never one per call.
 *
 * It proves its infrastructure role (the task attests as Mention); customer
 * keys are never a fallback. Session-less reads carry the workload token
 * (`serviceIdentity: 'when-anonymous'`). `applicationId` is
 * `MENTION_SERVICE_APPLICATION_ID`, the variable the backend reads; unset, the
 * SDK reads the application off the workload's own service token.
 */
export function createOxyServiceClient(config: OxyServiceClientConfig): OxyServer {
  return new OxyServer({
    baseURL: config.oxyApiUrl,
    ...(config.applicationId ? { applicationId: config.applicationId } : {}),
    serviceIdentity: 'when-anonymous',
    workloadCredentials: createAwsWorkloadCredentialProvider(),
  });
}
