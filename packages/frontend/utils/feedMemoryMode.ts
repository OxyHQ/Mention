/**
 * Feed memory-mode gate.
 *
 * A tiny, dependency-free module so the gate logic can be unit-tested without
 * pulling in SQLite, Zustand, or network layers.
 *
 * "Memory mode" means feed items live in local React state (instead of SQLite).
 * It is active when:
 *   1. The feed is scoped/filtered (useScoped is true), OR
 *   2. SQLite is unavailable (web without COOP/COEP — SharedArrayBuffer absent)
 */

/**
 * Resolve whether a feed should use the in-memory path.
 *
 * @param useScoped - true when the feed has filters (postId, parentPostId, etc.)
 * @param dbAvailable - result of isDbAvailable() — true on native, true on web
 *   only when SharedArrayBuffer is present (COOP/COEP headers enabled)
 */
export function resolveUseMemoryFeed(useScoped: boolean | undefined, dbAvailable: boolean): boolean {
    return !!(useScoped) || !dbAvailable;
}
