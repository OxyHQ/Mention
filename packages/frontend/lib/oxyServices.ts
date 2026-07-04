import { OxyServices } from '@oxyhq/core';
import { OXY_BASE_URL } from '@/config';

/**
 * Shared OxyServices instance for use throughout the app.
 * This is the same instance that's passed to OxyProvider in AppProviders.
 *
 * Only baseURL (the Oxy API) is needed. Session restore is device-first and
 * owned entirely by OxyProvider's cold boot: on the first cross-apex visit it
 * runs a bootstrap hop to the Oxy API, then persists a per-origin rotating
 * refresh token so subsequent reloads stay signed in offline. There is no
 * per-apex auth.<apex> iframe/CNAME anymore, so no authWebUrl is configured.
 */
export const oxyServices = new OxyServices({ baseURL: OXY_BASE_URL });
