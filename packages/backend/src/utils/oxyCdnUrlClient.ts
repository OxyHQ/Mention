import { OxyServices } from '@oxy.so/core';
import { config } from '../config';

/**
 * A bare, unauthenticated `OxyServices` used ONLY to BUILD public URLs.
 *
 * `getFileDownloadUrl`, `getCloudURL` and `getBaseURL` are synchronous string
 * construction: no request, no credential, no state. They are also the canonical
 * chokepoint for `cloud.oxy.so/<id>` — nothing in this codebase may hardcode
 * that host — so every module that renders a media URL needs them.
 *
 * They lived on `getServiceOxyClient()` in `utils/oxyHelpers`, which is the
 * SERVICE-AUTHENTICATED singleton: it reads the rotating credential, installs
 * egress instrumentation, and reaches `@oxyhq/mcp` and the server entrypoint.
 * Depending on all of that to concatenate a string is what forced
 * `services/webShellRenderer.ts` — which deliberately keeps clear of the server
 * entrypoint — to build its own client and, from there, its own copy of the
 * media-proxy URL shape.
 *
 * So the pure half gets its own leaf module. `oxyHelpers` keeps the
 * authenticated singleton for everything that actually talks to Oxy.
 */
export const oxyCdnUrlClient: OxyServices = new OxyServices({ baseURL: config.oxyApiUrl });
