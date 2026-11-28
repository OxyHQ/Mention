/**
 * Serializes local draft mutations for each viewer. Within a JavaScript runtime
 * a promise chain orders them; across browser tabs sharing the same storage the
 * Web Locks API does, so a read-check-write in one tab cannot interleave with
 * another tab's. Native apps run one JavaScript runtime and have no such lock.
 */
type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

function lockManager(): LockManagerLike | null {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

export class DraftMutationQueue {
  private readonly pending = new Map<string, Promise<void>>();

  get size(): number {
    return this.pending.size;
  }

  run<T>(viewerId: string, mutation: () => Promise<T>): Promise<T> {
    const locks = lockManager();
    const guarded = locks
      ? () => locks.request(`mention-drafts:${viewerId}`, async () => mutation())
      : mutation;
    const previous = this.pending.get(viewerId);
    let result: Promise<T>;
    try {
      result = previous ? previous.then(guarded) : guarded();
    } catch (error) {
      result = Promise.reject(error);
    }
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.pending.set(viewerId, settled);
    void settled.then(() => {
      if (this.pending.get(viewerId) === settled) this.pending.delete(viewerId);
    });
    return result;
  }
}

export const draftMutationQueue = new DraftMutationQueue();
