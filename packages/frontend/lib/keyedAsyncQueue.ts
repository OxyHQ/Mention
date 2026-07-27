/**
 * Serialize asynchronous work per key while allowing unrelated keys to run in
 * parallel. Identity-owned persistence uses this to make an account reset a
 * real storage barrier: old writes finish first, then removal, then any new
 * session read/write for that same viewer.
 */
export function createKeyedAsyncQueue() {
  const tails = new Map<string, Promise<void>>();

  return function enqueue<T>(
    key: string,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );

    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    });

    return result;
  };
}
