import { OxyServices } from '@oxyhq/core';
import { OXY_BASE_URL } from '@/config';

/**
 * Shared OxyServices instance for use throughout the app.
 * This is the same instance that's passed to OxyProvider in AppProviders.
 *
 * Session restore is device-first and owned entirely by OxyProvider's cold boot:
 * local `{deviceId, deviceSecret}` mint, then silent OAuth (`prompt=none`) when
 * no credential exists on web. Only `baseURL` is configured here.
 */
export const oxyServices = new OxyServices({ baseURL: OXY_BASE_URL });
