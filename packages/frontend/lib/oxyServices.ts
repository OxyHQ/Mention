import { OxyServices } from '@oxyhq/core';
import { OXY_BASE_URL } from '@/config';

/**
 * Shared OxyServices instance for use throughout the app
 * This is the same instance that's passed to OxyProvider in _layout.tsx
 *
 * authWebUrl is intentionally omitted so the SDK auto-detects the first-party
 * IdP at auth.<apex> (e.g. auth.mention.earth) from window.location. This keeps
 * cross-domain session restore first-party on Safari/Firefox and works on
 * preview deployments without hardcoding a host.
 */
export const oxyServices = new OxyServices({ baseURL: OXY_BASE_URL });
