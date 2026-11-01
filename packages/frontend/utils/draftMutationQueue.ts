/** Serializes local draft mutations for each viewer in this JavaScript runtime. */
export class DraftMutationQueue {
  private readonly pending = new Map<string, Promise<void>>();

  get size(): number {
    return this.pending.size;
  }

  run<T>(viewerId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(viewerId);
    let result: Promise<T>;
    try {
      result = previous ? previous.then(mutation) : mutation();
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
