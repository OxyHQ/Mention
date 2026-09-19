import { OxyServices } from "@oxy.so/core";

/**
 * An Oxy client that authenticates as this service, however this process can.
 *
 * Two ways, and a deployment has one of them without anybody configuring it: in
 * ECS the task role attests — a signed `GetCallerIdentity` that Oxy replays to
 * AWS, with no secret stored anywhere (oxy ADR 0026) — and elsewhere the
 * `OXY_SERVICE_API_KEY`/`OXY_SERVICE_API_SECRET` pair does.
 *
 * `configureServiceAuth` is therefore called only when there is a pair to call
 * it with. Handing it two `undefined`s would install a credential that cannot
 * mint anything, and `getServiceToken()` would stop falling back to the
 * attestation it is perfectly able to make — turning a working deployment into
 * one that fails on its first introspection.
 */
export function oxyServiceClient(config: {
  readonly oxyApiUrl: string;
  readonly oxyServiceApiKey?: string;
  readonly oxyServiceApiSecret?: string;
}): OxyServices {
  const oxy = new OxyServices({ baseURL: config.oxyApiUrl });
  if (config.oxyServiceApiKey && config.oxyServiceApiSecret) {
    oxy.configureServiceAuth(config.oxyServiceApiKey, config.oxyServiceApiSecret);
  }
  return oxy;
}
