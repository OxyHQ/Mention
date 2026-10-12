/**
 * The web shell's index.html, as the backend holds it.
 *
 * The shell Worker serves ONE release's document and, on each deploy, drops the
 * previous release's hashed chunks. A cached copy of the document is therefore a
 * promise to browsers that chunks exist — and it stops being true the moment the
 * Worker is redeployed. Held for ten minutes in every task's memory, it sent
 * browsers to chunks that had already 404ed ("Requiring unknown module").
 *
 * So the copy is kept only as a latency shortcut, never as a source of truth:
 *
 *   - it is trusted for seconds ({@link SHELL_TTL_MS}), not minutes;
 *   - past that it is revalidated with the Worker's ETag, so a release that did
 *     not change the document costs a 304, and one that did replaces it at once;
 *   - {@link invalidateShellDocument} marks it stale the instant anything sees
 *     evidence of a newer release (a hashed chunk the Worker no longer has).
 *
 * Kept here, not in `routes/webShell.routes.ts`, so the apex proxy can invalidate
 * it without importing the route module (which imports the proxy).
 */
import { config } from '../config';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';

/**
 * Header the shell Worker requires before it serves a byte
 * (`packages/frontend/worker/index.js`). Re-exported by the apex proxy, which is
 * where callers have always imported it from.
 */
export const SHELL_ACCESS_HEADER = 'X-Mention-Shell-Key';

/** Frontend CDN origin the static SPA shell is fetched from (NOT the apex — that would loop the Origin Rule). */
const SHELL_ORIGIN = `${config.web.shellOrigin}/`;
/** The Worker serves nothing without this key; an omitted key renders the fallback shell instead. */
const SHELL_ACCESS_KEY = config.web.shellAccessKey ?? '';
/** How long a fetched shell is trusted before it is revalidated. */
export const SHELL_TTL_MS = 15 * 1000;
/** Hard timeout for the shell fetch — a slow CDN must never block a page. */
const SHELL_FETCH_TIMEOUT_MS = 5000;

interface ShellCache {
  html: string;
  etag: string | null;
  fetchedAt: number;
}

let shellCache: ShellCache | null = null;
let shellInFlight: Promise<string | null> | null = null;

/**
 * Fetch the shell, conditionally when a copy is held. A 304 keeps the copy and
 * renews its trust; anything unusable returns null (never throws).
 */
async function fetchShellHtml(
  held: ShellCache | null,
): Promise<{ html: string; etag: string | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHELL_FETCH_TIMEOUT_MS);
  try {
    const startedAt = performance.now();
    const response = await fetch(SHELL_ORIGIN, {
      headers: {
        Accept: 'text/html',
        [SHELL_ACCESS_HEADER]: SHELL_ACCESS_KEY,
        ...(held?.etag ? { 'If-None-Match': held.etag } : {}),
      },
      signal: controller.signal,
    });
    // The shell origin is not Oxy, but it is a round trip on the page's path
    // when the process cache is cold; timed so that cost is visible.
    metrics.recordLatency('web_shell_fetch_ms', performance.now() - startedAt, {
      status: response.ok || response.status === 304 ? 'ok' : 'error',
    });
    if (response.status === 304 && held) {
      return { html: held.html, etag: held.etag };
    }
    if (!response.ok) {
      logger.warn(`[webShell] Shell fetch returned ${response.status}`);
      return null;
    }
    return { html: await response.text(), etag: response.headers?.get?.('etag') ?? null };
  } catch (error) {
    logger.warn('[webShell] Shell fetch failed', error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Refresh the cached shell, de-duplicating concurrent refreshes into one fetch. */
function refreshShell(): Promise<string | null> {
  if (!shellInFlight) {
    shellInFlight = fetchShellHtml(shellCache)
      .then((fetched) => {
        if (fetched) shellCache = { ...fetched, fetchedAt: Date.now() };
        return shellCache?.html ?? null;
      })
      .finally(() => {
        shellInFlight = null;
      });
  }
  return shellInFlight;
}

/**
 * Return the SPA shell. Fresh within {@link SHELL_TTL_MS}; past it, the held copy
 * is served while a background revalidation runs (so a slow CDN never blocks a
 * page); a cold cache awaits the first successful fetch. Null only when there is
 * no copy and the fetch failed.
 */
export async function getShell(): Promise<string | null> {
  if (shellCache && Date.now() - shellCache.fetchedAt < SHELL_TTL_MS) {
    return shellCache.html;
  }
  if (shellCache) {
    void refreshShell();
    return shellCache.html;
  }
  return refreshShell();
}

/**
 * Mark the held shell stale and start revalidating it. Called when a hashed chunk
 * the document promised turns out not to exist: a newer release is live, so the
 * next page must not be built from this copy.
 */
export function invalidateShellDocument(): void {
  if (!shellCache) return;
  shellCache = { ...shellCache, fetchedAt: 0 };
  void refreshShell();
}

/** Test seam: forget the held shell. */
export function resetShellDocumentForTests(): void {
  shellCache = null;
  shellInFlight = null;
}
