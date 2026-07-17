/**
 * Native no-op for the web-only stale-chunk recovery.
 *
 * Native builds ship a single embedded JS bundle — there are no hashed async
 * route chunks that can go stale, so there is nothing to recover. See
 * `chunkReload.web.ts` for the web implementation.
 */
export function registerChunkErrorRecovery(): void {
  // intentionally empty on native
}
