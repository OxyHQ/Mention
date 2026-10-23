import { act } from 'react-test-renderer';

/**
 * Wait until `predicate` holds, flushing React and pending timers between
 * checks. Wait on a value the tree has actually RENDERED.
 *
 * A fixed tick races anything that resolves in more than one step — a query
 * that starts only once another has answered, a mutation followed by its
 * invalidation — and the race is lost on a loaded machine (a full coverage
 * run), never on a quiet one. Nor is `client.isFetching() === 0` a substitute:
 * React Query notifies its subscribers on a macrotask AFTER the fetch count
 * drops, and a dependent query has not started yet in between. What makes a
 * test deterministic is that nothing after the call runs until the condition
 * is actually true.
 *
 * The iteration cap is a FAILURE ceiling, not the wait: a condition that never
 * becomes true reports itself by name instead of hanging to jest's timeout.
 */
export async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const FAILURE_CEILING = 500;
  for (let attempt = 0; attempt < FAILURE_CEILING; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`waitUntil never saw: ${description}`);
}
