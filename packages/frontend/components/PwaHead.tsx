import { useEffect } from 'react';
import { Platform } from 'react-native';

/**
 * Runtime PWA head injector (WEB ONLY).
 *
 * Expo's `output: "single"` web export ships a bare `index.html` — the
 * `web.manifest` + `web.meta` declared in `app.config.js` are NOT wired into it,
 * so the browser never sees the manifest link or the apple/theme metas. Without a
 * live `<link rel="manifest">` there is no installable PWA and the Web Share
 * Target (`/compose`) is dead.
 *
 * The browser evaluates PWA installability and the Share Target from the LIVE DOM,
 * so injecting these tags into `document.head` at runtime is sufficient — no
 * server/worker involvement is required. This mirrors exactly what the Cloudflare
 * Pages worker's `PWA_HEAD` used to append; ownership now moves into the app so the
 * worker can be retired.
 *
 * Mounted ONCE at the app root (present on every page). Renders nothing. The
 * append is idempotent (guards on existing tags) so a stray remount can't
 * duplicate anything. `document.head` mutation is a genuine external-system side
 * effect, which is the legitimate use for `useEffect`.
 */

const MANIFEST_HREF = '/manifest.json';

const PWA_META_TAGS: ReadonlyArray<{ name: string; content: string }> = [
  { name: 'theme-color', content: '#0B0B0F' },
  { name: 'apple-mobile-web-app-capable', content: 'yes' },
  { name: 'apple-mobile-web-app-title', content: 'Mention' },
  { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
];

export function PwaHead(): null {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    const head = document.head;
    if (!head) return;

    if (!head.querySelector('link[rel="manifest"]')) {
      const link = document.createElement('link');
      link.rel = 'manifest';
      link.href = MANIFEST_HREF;
      head.appendChild(link);
    }

    for (const { name, content } of PWA_META_TAGS) {
      if (head.querySelector(`meta[name="${name}"]`)) continue;
      const meta = document.createElement('meta');
      meta.name = name;
      meta.content = content;
      head.appendChild(meta);
    }
  }, []);

  return null;
}

export default PwaHead;
