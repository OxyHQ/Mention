import { OxyServices } from '@oxyhq/core';
import { OXY_BASE_URL, OXY_AUTH_URL } from '@/config';

/**
 * Shared OxyServices instance for use throughout the app
 * This is the same instance that's passed to OxyProvider in _layout.tsx
 */
export const oxyServices = new OxyServices({ baseURL: OXY_BASE_URL, authWebUrl: OXY_AUTH_URL });
