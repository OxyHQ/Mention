/**
 * Functional test for the SQLite availability gate (isDbAvailable).
 *
 * WHAT WE TEST
 * ------------
 * The production bug: on web without COOP/COEP headers, `SharedArrayBuffer`
 * is undefined → `isDbAvailable()` returns false → the feed must fall back to
 * the in-memory path (`resolveUseMemoryFeed === true`).
 *
 * We import the real `database.ts` module (not a contract replica) so the test
 * exercises the actual runtime logic, including the `Platform.OS` branch and
 * the `typeof SharedArrayBuffer !== 'undefined'` check.
 *
 * WHY `jest.isolateModules()` PER CASE
 * -------------------------------------
 * `database.ts` memoises the first result of `isDbAvailable()` in a module-level
 * variable `_isAvailable`. Without isolation each require() call returns the same
 * cached module instance (and its cached `_isAvailable` value), making test order
 * matter. `jest.isolateModules()` forces Node to resolve a fresh module graph for
 * every synchronous `require()` call inside the callback, so each case starts with
 * `_isAvailable === null`.
 *
 * WHY TOP-LEVEL `jest.mock()` CALLS
 * ----------------------------------
 * Top-level `jest.mock()` calls are hoisted by Babel/jest before any `import` or
 * `require` executes. They install a factory into the jest module registry that
 * persists across `isolateModules` blocks (the mock factory is re-executed for
 * each fresh module instance). This means we never need to re-declare the mocks
 * inside each isolated block.
 *
 * IMPORT STRATEGY
 * ---------------
 * We import `database.ts` directly (real module) because:
 *   - Its only external dependencies are `react-native` (mocked below) and
 *     `@/lib/logger` (mocked below). Both are pure TypeScript with no native
 *     bindings that would fail to transform under jest-expo.
 *   - `expo-sqlite` is NOT imported at module load time — it is lazy-required
 *     inside `getDb()`, which we never call here.
 *   - The TypeScript path alias `@/lib/logger` is resolved by jest-expo's
 *     default moduleNameMapper (`@/*` → `<rootDir>/*`).
 */

// Ensure RN globals expected by jest-expo preset are in place
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

// ── Mocks (hoisted) ─────────────────────────────────────────────────────────

/**
 * Mock `react-native` to expose only what database.ts needs: Platform.OS.
 * We set OS = 'web' here; tests that need 'android' can override per-case.
 * The factory is a function so jest.isolateModules re-executes it each time.
 */
jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

/**
 * Mock the logger so database.ts can call createScopedLogger / logger.debug
 * without triggering the real transport chain (which pulls in Platform again).
 */
jest.mock('@/lib/logger', () => {
  const noop = () => {};
  const noopLogger = {
    debug: noop,
    info: noop,
    log: noop,
    warn: noop,
    error: noop,
  };
  return {
    createScopedLogger: () => noopLogger,
    logger: noopLogger,
  };
});

// ── Import the pure gate helper (no SQLite, no Platform) ────────────────────

import { resolveUseMemoryFeed } from '../../utils/feedMemoryMode';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load a fresh copy of database.ts inside an isolated module scope.
 * Returns the `isDbAvailable` export from that fresh instance.
 */
function loadFreshIsDbAvailable(): () => boolean {
  let isDbAvailable!: () => boolean;
  jest.isolateModules(() => {
    // require() here gets a brand-new module with _isAvailable === null
    ({ isDbAvailable } = require('../database'));
  });
  return isDbAvailable;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('isDbAvailable — SQLite runtime availability gate', () => {
  // Save the original SharedArrayBuffer so we can restore it after each test
  const originalSharedArrayBuffer = globalThis.SharedArrayBuffer;

  afterEach(() => {
    // Restore SharedArrayBuffer to whatever it was before the test ran
    if (originalSharedArrayBuffer === undefined) {
      delete (globalThis as Record<string, unknown>).SharedArrayBuffer;
    } else {
      (globalThis as Record<string, unknown>).SharedArrayBuffer =
        originalSharedArrayBuffer;
    }
  });

  // ── Case A: the exact production bug scenario ──────────────────────────────

  describe('Case A — web without SharedArrayBuffer (production bug scenario)', () => {
    it('isDbAvailable() returns false when Platform.OS is web and SharedArrayBuffer is absent', () => {
      // Simulate a web environment without COOP/COEP headers
      delete (globalThis as Record<string, unknown>).SharedArrayBuffer;

      const isDbAvailable = loadFreshIsDbAvailable();
      expect(isDbAvailable()).toBe(false);
    });

    it('resolveUseMemoryFeed returns true when isDbAvailable() is false — feed falls back to memory path', () => {
      delete (globalThis as Record<string, unknown>).SharedArrayBuffer;

      const isDbAvailable = loadFreshIsDbAvailable();

      // This is the exact data flow from useFeedState.ts:
      //   const useMemoryFeed = resolveUseMemoryFeed(useScoped, isDbAvailable())
      // With useScoped=false (global feed, not filtered) and db unavailable,
      // the feed MUST switch to the memory path.
      expect(resolveUseMemoryFeed(false, isDbAvailable())).toBe(true);
    });

    it('isDbAvailable() memoises false — second call without resetting module returns the same value', () => {
      delete (globalThis as Record<string, unknown>).SharedArrayBuffer;

      const isDbAvailable = loadFreshIsDbAvailable();
      // First call computes and caches _isAvailable = false
      expect(isDbAvailable()).toBe(false);
      // Second call on the same module instance must return cached false,
      // even if we restore SharedArrayBuffer between calls.
      (globalThis as Record<string, unknown>).SharedArrayBuffer =
        originalSharedArrayBuffer ?? function SharedArrayBuffer() {};
      expect(isDbAvailable()).toBe(false);
    });
  });

  // ── Case B: web WITH SharedArrayBuffer (COOP/COEP headers present) ─────────

  describe('Case B — web with SharedArrayBuffer present (COOP/COEP headers active)', () => {
    it('isDbAvailable() returns true when Platform.OS is web and SharedArrayBuffer is defined', () => {
      // Ensure SharedArrayBuffer is present (it may already be in the test runner,
      // but we set it explicitly to make the test self-documenting)
      (globalThis as Record<string, unknown>).SharedArrayBuffer =
        // Use the real one if available, otherwise a stub function that satisfies
        // `typeof SharedArrayBuffer !== 'undefined'`
        originalSharedArrayBuffer ?? function SharedArrayBuffer() {};

      const isDbAvailable = loadFreshIsDbAvailable();
      expect(isDbAvailable()).toBe(true);
    });

    it('resolveUseMemoryFeed returns false when isDbAvailable() is true — feed uses SQLite path', () => {
      (globalThis as Record<string, unknown>).SharedArrayBuffer =
        originalSharedArrayBuffer ?? function SharedArrayBuffer() {};

      const isDbAvailable = loadFreshIsDbAvailable();
      // Global unscoped feed on web with SQLite available → SQLite path
      expect(resolveUseMemoryFeed(false, isDbAvailable())).toBe(false);
    });
  });

  // ── Case C: native platform (always available) ─────────────────────────────

  describe('Case C — native platform (Platform.OS !== web)', () => {
    it('isDbAvailable() returns true on native regardless of SharedArrayBuffer', () => {
      // Override the top-level react-native mock for this isolated block only.
      // We cannot use jest.mock() conditionally, but we CAN use jest.isolateModules
      // with a jest.doMock() (non-hoisted) inside the isolated scope.
      delete (globalThis as Record<string, unknown>).SharedArrayBuffer;

      let isDbAvailable!: () => boolean;
      jest.isolateModules(() => {
        jest.doMock('react-native', () => ({
          Platform: { OS: 'android' },
        }));
        jest.doMock('@/lib/logger', () => {
          const noop = () => {};
          return {
            createScopedLogger: () => ({
              debug: noop, info: noop, log: noop, warn: noop, error: noop,
            }),
            logger: { debug: noop, info: noop, log: noop, warn: noop, error: noop },
          };
        });
        ({ isDbAvailable } = require('../database'));
      });

      expect(isDbAvailable()).toBe(true);
      // And consequently the feed does NOT force memory mode
      expect(resolveUseMemoryFeed(false, isDbAvailable())).toBe(false);
    });
  });
});
