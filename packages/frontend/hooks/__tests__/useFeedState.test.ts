/**
 * Tests for the feed memory-mode gate (resolveUseMemoryFeed).
 *
 * We test the pure utility function from `utils/feedMemoryMode` which has zero
 * runtime dependencies. This avoids pulling in SQLite, Zustand, @oxyhq/core ESM
 * and other modules that don't transform cleanly in the jest-expo environment.
 *
 * The gate is the root cause of the production bug (web feed empty after SDK 56):
 * when isDbAvailable() === false, the hook must use the in-memory path instead
 * of writing/reading from a null SQLite handle.
 */

// Set up globals expected by RN/Expo modules
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

import { resolveUseMemoryFeed } from '../../utils/feedMemoryMode';

// ── Gate unit tests ─────────────────────────────────────────────────────────

describe('resolveUseMemoryFeed (DB availability gate)', () => {
    it('returns false when SQLite is available and feed is not scoped — SQLite path (native)', () => {
        expect(resolveUseMemoryFeed(false, true)).toBe(false);
    });

    it('returns false when useScoped is undefined and SQLite is available', () => {
        expect(resolveUseMemoryFeed(undefined, true)).toBe(false);
    });

    it('returns true when SQLite is unavailable and feed is not scoped — web without COOP/COEP', () => {
        // This is the production bug scenario: web, no SharedArrayBuffer → memory path
        expect(resolveUseMemoryFeed(false, false)).toBe(true);
    });

    it('returns true when SQLite is unavailable and useScoped is undefined', () => {
        expect(resolveUseMemoryFeed(undefined, false)).toBe(true);
    });

    it('returns true when useScoped is true and SQLite is available — scoped/filtered feed on native', () => {
        expect(resolveUseMemoryFeed(true, true)).toBe(true);
    });

    it('returns true when both useScoped and SQLite unavailable', () => {
        expect(resolveUseMemoryFeed(true, false)).toBe(true);
    });

    it('covers all four (useScoped × dbAvailable) combinations exhaustively', () => {
        const cases: [boolean | undefined, boolean, boolean][] = [
            // [useScoped, dbAvailable, expectedUseMemory]
            [false,     true,  false],  // Native, no filters → SQLite path
            [false,     false, true],   // Web no COOP/COEP, no filters → memory path
            [true,      true,  true],   // Native, filtered → memory path (scoped)
            [true,      false, true],   // Web no COOP/COEP, filtered → memory path
            [undefined, true,  false],  // useScoped omitted, SQLite available → SQLite
            [undefined, false, true],   // useScoped omitted, no SQLite → memory
        ];

        for (const [useScoped, dbAvailable, expected] of cases) {
            expect(resolveUseMemoryFeed(useScoped, dbAvailable)).toBe(expected);
        }
    });
});
