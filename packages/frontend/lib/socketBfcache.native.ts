/**
 * Native no-op for the web-only back/forward-cache socket release.
 *
 * There is no page lifecycle on native — the app is never frozen into a document
 * cache, and `socketService` already reconnects from its own AppState handler
 * when the app returns to the foreground. See `socketBfcache.web.ts`.
 */
export function registerSocketBfcacheRelease(): () => void {
  return () => undefined;
}
