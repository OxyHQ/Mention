import { jest } from 'bun:test';

/**
 * Resolve on the next REAL macrotask. `jest.useFakeTimers()` fakes
 * `setTimeout`, `setImmediate` and `Bun.sleep`, but not `MessageChannel`, so
 * awaiting this lets every queued microtask (and every one those queue) run
 * without moving the fake clock. It is the yield `@sinonjs/fake-timers`, behind
 * Vitest's async timer calls, takes between timers.
 */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

/**
 * `bun test`'s stand-in for Vitest's `vi.advanceTimersByTimeAsync(ms)`, which
 * `bun:test` does not have. Fake timers must be on, as for the Vitest call.
 *
 * Bun's `jest.advanceTimersByTime` already drains the microtask queue after
 * each timer it fires, so a timer that a promise continuation schedules inside
 * the window still fires inside it. The yields before and after add the rest:
 * promise chains already in flight (a fetch mock resolving, a timer registered
 * after an `await`) settle before time moves, and the continuations of the last
 * timer have run when this resolves.
 *
 * `ms` 0 only yields: bun's `advanceTimersByTime(0)` moves the clock by 1ms,
 * which would shift every TTL a test measures afterwards.
 */
export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  await nextMacrotask();
  if (ms > 0) jest.advanceTimersByTime(ms);
  await nextMacrotask();
}
