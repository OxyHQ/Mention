/**
 * The backend's ONE Mercaria client (#951).
 *
 * Commerce belongs to Mercaria, and Mention reaches it only through
 * `@mercaria.co/sdk` (Mercaria#1017): Mention → SDK → Mercaria's public API.
 * Everything that knows Mercaria's transport lives in the SDK — the routes, the
 * wire envelope, the DTO parsing, the ref shapes, the typed errors and the
 * canonical links. This module only CONFIGURES a client; it holds no HTTP code,
 * no URL and no copy of a Mercaria type, and `validate:commerce-boundary` fails
 * the build if a Mercaria host or public-API path appears anywhere else in
 * Mention's production source.
 *
 * ANONYMOUS READS ONLY, for now. No `getAccessToken` is passed, so every request
 * is sent without an `Authorization` header and every response is the same for
 * every viewer — which is also what makes a shared cache of one safe (the SDK
 * README: responses `Vary: Authorization`). Forwarding a viewer's Oxy token
 * (for `product.viewer`) is a deliberate later change, and it has to come with
 * per-user cache keys wherever these reads are cached.
 */

import { createMercariaClient, type MercariaClient } from '@mercaria.co/sdk';
import { config } from '../../config';

let client: MercariaClient | undefined;

/**
 * The shared client, created on first use.
 *
 * Lazy so that importing a module that MAY hydrate commerce refs costs nothing
 * for a process that never does. An unset `MERCARIA_API_URL`/`MERCARIA_WEB_URL`
 * passes `undefined`, which the SDK resolves to its own production origins.
 * The client is stateless beyond its options, so one instance serves every
 * request.
 */
export function getMercariaClient(): MercariaClient {
  client ??= createMercariaClient({
    apiBaseUrl: config.mercaria.apiUrl,
    webBaseUrl: config.mercaria.webUrl,
    timeoutMs: config.mercaria.timeoutMs,
  });
  return client;
}
