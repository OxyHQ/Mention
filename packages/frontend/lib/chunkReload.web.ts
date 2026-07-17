/**
 * Web-only recovery from a stale lazy-route chunk failing to load.
 *
 * expo-router code-splits each route into a hashed async chunk. After a web
 * deploy the previously-loaded bundle's chunk hashes no longer exist on the
 * host, which serves `index.html` (text/html) for the missing `*.js`. Metro's
 * async require then rejects with an `AsyncRequireError` ("Loading module …
 * failed"), so tapping into a not-yet-loaded route (e.g. an Explore topic) dies
 * with no recovery.
 *
 * This registers a one-shot, loop-guarded listener that reloads the page onto
 * the fresh bundle when it sees that failure. The loop guard is a short-lived
 * `sessionStorage` timestamp: a second failure within the cooldown is treated as
 * a genuinely-broken chunk (not merely stale) and is logged instead of reloading
 * forever.
 *
 * The module is platform-split — `chunkReload.native.ts` is a no-op.
 */

import { logger } from '@/lib/logger';

/** sessionStorage key holding the epoch-ms of the last recovery reload. */
const RELOAD_STAMP_KEY = 'mention:chunkReloadAt';
/** A second chunk failure within this window is a real break, not a stale hash. */
const RELOAD_COOLDOWN_MS = 10_000;
/** Metro serves the web route chunks from this path prefix. */
const EXPO_CHUNK_PATH = '/_expo/static/js/';

let registered = false;

/** Read an error-like value's `name`/`message` as plain strings (metadata-safe). */
function describeError(value: unknown): { name: string; message: string } {
  const named = value as { name?: unknown; message?: unknown } | null | undefined;
  const name = typeof named?.name === 'string' ? named.name : '';
  const message =
    typeof named?.message === 'string' ? named.message : typeof value === 'string' ? value : '';
  return { name, message };
}

function isChunkLoadError(value: unknown): boolean {
  if (!value) return false;
  const { name, message } = describeError(value);
  return (
    name === 'AsyncRequireError' ||
    name === 'ChunkLoadError' ||
    /Loading module .* failed/i.test(message) ||
    /Loading chunk \S+ failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message)
  );
}

function readStamp(): number {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_STAMP_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    // sessionStorage can throw in private mode / sandboxed frames.
    return 0;
  }
}

function writeStamp(value: number): boolean {
  try {
    window.sessionStorage.setItem(RELOAD_STAMP_KEY, String(value));
    return true;
  } catch {
    return false;
  }
}

function clearStamp(): void {
  try {
    window.sessionStorage.removeItem(RELOAD_STAMP_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

function recover(error: unknown): void {
  const now = Date.now();
  const lastReloadAt = readStamp();

  if (lastReloadAt && now - lastReloadAt < RELOAD_COOLDOWN_MS) {
    // We already reloaded moments ago and a chunk still failed: it is broken, not
    // merely stale. Surface it rather than reload in a loop.
    logger.error('Route chunk still failing after a recovery reload; not reloading again', {
      error: describeError(error),
    });
    return;
  }

  if (!writeStamp(now)) {
    // Without a persisted guard a reload risks an infinite loop — refuse.
    logger.error('Stale route chunk detected but the reload guard is unavailable; not reloading', {
      error: describeError(error),
    });
    return;
  }

  logger.warn('Stale route chunk failed to load; reloading onto the fresh bundle', {
    error: describeError(error),
  });
  window.location.reload();
}

export function registerChunkErrorRecovery(): void {
  if (registered) return;
  registered = true;

  // A stable prior load means any earlier recovery succeeded: drop an expired
  // stamp so a future deploy gets a fresh single-reload budget. A stamp still
  // inside the cooldown is kept, so an immediate re-failure is caught by
  // `recover`'s loop guard rather than reloading again.
  const lastReloadAt = readStamp();
  if (lastReloadAt && Date.now() - lastReloadAt >= RELOAD_COOLDOWN_MS) {
    clearStamp();
  }

  // Primary path: Metro's async require rejects the dynamic import, surfacing as
  // an unhandled promise rejection. We never preventDefault — this is additive.
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    if (isChunkLoadError(reason)) recover(reason);
  });

  // Fallback path: a dynamic-import `<script>` failing fires an `error` event
  // that does NOT bubble, so it is only observable in the capture phase. Scope
  // recovery to Expo's own chunk scripts so unrelated resource errors (images,
  // third-party scripts) never trigger a reload.
  window.addEventListener(
    'error',
    (event) => {
      const target = event.target;
      if (target instanceof HTMLScriptElement && target.src.includes(EXPO_CHUNK_PATH)) {
        recover(new Error(`Route chunk script failed to load: ${target.src}`));
        return;
      }
      const err: unknown = event.error;
      if (isChunkLoadError(err)) recover(err);
    },
    true,
  );
}
