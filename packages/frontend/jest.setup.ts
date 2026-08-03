// `timeoutManager` is query-core's, re-exported here because react-query is the
// package this workspace declares. One copy of query-core resolves in the tree,
// so the re-export is the same singleton its internals arm.
import { timeoutManager } from '@tanstack/react-query';
import { configureAppLogging } from '@/lib/logging';

// The SDK logger defaults to `debug` whenever `__DEV__` is true, which jest-expo
// sets. Install the app's own transport policy instead so a test run shows the
// same (scrubbed, `info`-and-above) output the app itself produces.
configureAppLogging();

type TimerHandle = ReturnType<typeof setTimeout>;

/** `unref` is node's; the guard keeps this honest on a platform without it. */
function releaseTheEventLoop(handle: TimerHandle): TimerHandle {
  if (typeof handle === 'object' && handle !== null && typeof handle.unref === 'function') {
    handle.unref();
  }
  return handle;
}

/**
 * Stop React Query's five-minute timers from being a reason to keep node alive.
 *
 * `staleTime` and `gcTime` are both armed through query-core's `timeoutManager`
 * and both default to five minutes. A timer still pending when a test file
 * finishes holds the event loop open for its whole delay, so ONE such file adds
 * five minutes to the run: measured, the suite took 324s while jest reported 49s
 * of tests, and 300s of that was files waiting out timers nobody would observe.
 *
 * This belongs here rather than in the test files because the two cases found so
 * far arm through OPPOSITE lifecycles. A test that leaves its tree mounted keeps
 * the observer's `staleTime` timer (`QueryObserver.#updateStaleTimeout`); a test
 * that dutifully unmounts arms the `gcTime` one instead, because `removeObserver`
 * calls `scheduleGc`. "Remember to unmount" therefore causes the second case
 * rather than preventing it. Nothing about it is attributable either: jest
 * reports such a file at well under a second, the process merely does not exit
 * afterwards, and `--detectOpenHandles` names nothing at all.
 *
 * `unref` rather than a shorter `gcTime`/`staleTime` default, because this must
 * not change what the cache DOES under test — a query collected early would
 * break the tests that seed one with `setQueryData`. An unref'd timer still
 * fires normally while anything else is running; it just stops being the last
 * thing standing. `setTimeoutProvider` is query-core's own documented extension
 * point, and `setupFiles` runs before any test file's imports, so it is in place
 * before the first timer can be armed through it.
 */
timeoutManager.setTimeoutProvider({
  setTimeout: (callback, delay) => releaseTheEventLoop(setTimeout(callback, delay)),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (callback, delay) => releaseTheEventLoop(setInterval(callback, delay)),
  clearInterval: (id) => clearInterval(id),
});
