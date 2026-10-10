import { OxyServer } from '@oxy.so/core/server';

/**
 * An Oxy client that authenticates as this service, however this process can.
 *
 * Two ways, and a deployment has one of them without anybody configuring it: in
 * ECS the task role attests — a signed `GetCallerIdentity` that Oxy replays to
 * AWS, with no secret stored anywhere (oxy ADR 0026) — and elsewhere the
 * `OXY_SERVICE_API_KEY`/`OXY_SERVICE_API_SECRET` pair does.
 *
 * `serviceAuth` is therefore passed only when there is a pair to pass. Handing
 * it two `undefined`s would install a credential that cannot mint anything,
 * and `serviceToken()` would stop falling back to the attestation it is
 * perfectly able to make — turning a working deployment into one that fails on
 * its first introspection.
 */
export function oxyServiceClient(config: {
  readonly oxyApiUrl: string;
  readonly oxyServiceApiKey?: string;
  readonly oxyServiceApiSecret?: string;
}): OxyServer {
  // Every request this client makes without a user session carries the
  // service token, not only `serviceRequest` ones (Mention#1173).
  return new OxyServer({
    baseURL: config.oxyApiUrl,
    serviceIdentity: 'when-anonymous',
    ...(config.oxyServiceApiKey && config.oxyServiceApiSecret
      ? { serviceAuth: { apiKey: config.oxyServiceApiKey, apiSecret: config.oxyServiceApiSecret } }
      : {}),
  });
}
