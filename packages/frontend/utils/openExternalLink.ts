import { Linking, Platform } from 'react-native';
import { openBrowserAsync, type WebBrowserOpenOptions } from 'expo-web-browser';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('openExternalLink');

/**
 * The ONE imperative entry point for opening an external link from post bodies,
 * profile bios, sources, and similar untrusted content. Post/bio hrefs come from
 * user-authored and federated (ActivityPub) content, so this is also a SECURITY
 * boundary: only web (`http`/`https`) and OS-handler (`mailto`/`tel`/`sms`)
 * schemes are ever opened. Everything else (`javascript:`, `data:`, `file:`, …)
 * is refused.
 *
 * Behavior by platform:
 * - Native: `http`/`https` open IN-APP via `expo-web-browser` (Safari View
 *   Controller / Chrome Custom Tab), keeping the user inside the app instead of
 *   kicking out to the system browser.
 * - Web: `http`/`https` open in a normal new tab with `noopener,noreferrer`
 *   (NOT `openBrowserAsync`, which forces a small popup window on web).
 * - `mailto:` / `tel:` / `sms:` on every platform go to the OS handler via
 *   `Linking.openURL` — the in-app browser cannot handle them.
 */

/** Schemes that must be handed to the OS handler rather than an in-app browser. */
const OS_HANDLER_SCHEMES = new Set(['mailto:', 'tel:', 'sms:']);
/** Schemes we open in-app (native) or in a new tab (web). */
const WEB_SCHEMES = new Set(['http:', 'https:']);

/**
 * Presentation overrides for the native in-app browser. Callers that live under a
 * `BloomColorScope` (e.g. profile theming) can forward `useTheme().colors` values
 * so the browser chrome matches the surrounding surface. Purely optional — the
 * defaults render a clean system browser.
 */
export type OpenExternalLinkOptions = Pick<
  WebBrowserOpenOptions,
  'toolbarColor' | 'controlsColor'
>;

function parseScheme(url: string): string | null {
  try {
    return new URL(url).protocol.toLowerCase();
  } catch {
    return null;
  }
}

export async function openExternalLink(
  url: string,
  options: OpenExternalLinkOptions = {},
): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) {
    return;
  }

  const scheme = parseScheme(trimmed);
  if (!scheme) {
    logger.warn('Refusing to open malformed URL', { url: trimmed });
    return;
  }

  if (OS_HANDLER_SCHEMES.has(scheme)) {
    try {
      await Linking.openURL(trimmed);
    } catch (error) {
      logger.warn('Failed to open URL with OS handler', { url: trimmed, error });
    }
    return;
  }

  if (!WEB_SCHEMES.has(scheme)) {
    logger.warn('Refusing to open URL with unsupported scheme', { url: trimmed, scheme });
    return;
  }

  if (Platform.OS === 'web') {
    // A normal new-tab open; `noopener,noreferrer` severs the `window.opener`
    // reverse-tabnabbing channel for untrusted external links.
    if (typeof window !== 'undefined') {
      window.open(trimmed, '_blank', 'noopener,noreferrer');
    }
    return;
  }

  try {
    await openBrowserAsync(trimmed, {
      toolbarColor: options.toolbarColor,
      controlsColor: options.controlsColor,
    });
  } catch (error) {
    // The in-app browser can fail (no supported browser, backgrounded launch,
    // etc.). Fall back to the system browser rather than crashing the caller.
    logger.warn('In-app browser failed; falling back to system browser', { url: trimmed, error });
    try {
      await Linking.openURL(trimmed);
    } catch (fallbackError) {
      logger.warn('Fallback system browser also failed', { url: trimmed, error: fallbackError });
    }
  }
}
