/**
 * A minimal, dependency-free bounded-concurrency map.
 *
 * WHY
 *   Shared by the I/O-bound one-shot repair sweeps (`reingestBlueskyPosts`,
 *   `pruneGoneFederatedActors`, `syncBlueskyStarterPacks`) AND the runtime atproto
 *   connector's starter-pack member resolution. Each item does a remote fetch plus
 *   oxy-api round-trips, so processing one item at a time leaves the CPU idle
 *   waiting on the network. Overlapping a small pool recovers roughly an order of
 *   magnitude of wall-clock time while keeping the load on the remote / oxy-api
 *   endpoints bounded (oxy-api's service endpoints are per-IP rate-limited, and
 *   Mention's federation traffic egresses from one NAT IP).
 */

/** Default in-flight pool size — conservative so a sweep never hammers oxy-api. */
export const DEFAULT_CONCURRENCY = 8;

/** Upper bound the `--concurrency` flag is clamped to (guards against a fat-finger). */
export const MAX_CONCURRENCY = 32;

/**
 * Run `worker` over `items` with at most `concurrency` calls in flight at once,
 * resolving once EVERY item has settled. A simple index-cursor promise pool: it
 * starts `min(concurrency, items.length)` worker loops that each pull the next
 * index off a shared cursor and process it until the list is drained, so the
 * number of concurrent `worker` calls never exceeds `concurrency`. The returned
 * array is index-aligned with `items`.
 *
 * Robust like `Promise.allSettled`: a `worker` that REJECTS never aborts the
 * batch or the other in-flight items — its rejection is captured as that item's
 * `{ status: 'rejected', reason }` slot, and every other item still runs to
 * completion. Callers that already convert their own failures into a value never
 * see a rejected slot; callers that let the worker throw get a per-item failure
 * they can classify.
 *
 * Reading and advancing the shared cursor is a synchronous, await-free critical
 * section, so in single-threaded JS each index is dispatched exactly once.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  const poolSize = Math.min(Math.max(1, concurrency), items.length);
  const pool: Promise<void>[] = [];
  for (let i = 0; i < poolSize; i++) pool.push(runWorker());
  await Promise.all(pool);
  return results;
}
