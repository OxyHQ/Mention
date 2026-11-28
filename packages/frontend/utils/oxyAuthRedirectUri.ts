import { Platform } from 'react-native';
import { OXY_AUTH_REDIRECT_URI } from '@/config';

/**
 * The web origins Mention's own deployment is served on: one web app on two
 * hosts (docs/mention-org-domain-move.md). Each must be registered with Oxy as a
 * redirect URI of Mention's client, exactly as written here.
 */
export const MENTION_WEB_ORIGINS: readonly string[] = [
  'https://mention.earth',
  'https://mention.org',
];

/**
 * The OAuth redirect URI for a page on `pageOrigin`: the page's own origin when it
 * is one of {@link MENTION_WEB_ORIGINS}, so signing in on mention.org returns to
 * mention.org; otherwise the configured one, unchanged (a managed deployment, a
 * staging origin, localhost, or no page at all).
 */
export function chooseOxyAuthRedirectUri(
  configured: string,
  pageOrigin: string | null | undefined,
): string {
  return pageOrigin && MENTION_WEB_ORIGINS.includes(pageOrigin) ? pageOrigin : configured;
}

/**
 * The redirect URI the Oxy provider is given. Web reads the page's origin; native
 * builds (and a render with no `window`) keep the build-time constant.
 */
export function resolveOxyAuthRedirectUri(configured: string = OXY_AUTH_REDIRECT_URI): string {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return configured;
  return chooseOxyAuthRedirectUri(configured, window.location?.origin);
}
