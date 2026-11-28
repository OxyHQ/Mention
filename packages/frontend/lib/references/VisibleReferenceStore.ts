export type ReferenceState<T> =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; value: T };

export interface ReferenceBatch<T> {
  items: T[];
  unavailableIds: string[];
}

type Listener = () => void;
interface ActiveBatch<T> {
  controller: AbortController;
  entries: Set<Entry<T>>;
}
interface Entry<T> {
  state: ReferenceState<T>;
  listeners: Set<Listener>;
  refresh?: ReturnType<typeof setTimeout>;
  inFlight?: ActiveBatch<T>;
}
const LOADING = { status: 'loading' } as const;
const UNAVAILABLE = { status: 'unavailable' } as const;

/**
 * Ephemeral visible-card state, deliberately outside feed/SQLite/query persistence.
 * Mounting a visible subscriber queues its ID; a short window groups a viewport.
 * Losing the final subscriber deletes the facts. Returning to view revalidates.
 */
export class VisibleReferenceStore<T extends { id: string }> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly pending = new Set<string>();
  private scheduled?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly load: (
      ids: readonly string[],
      options: { signal: AbortSignal },
    ) => Promise<ReferenceBatch<T>>,
    private readonly options: {
      batchDelayMs?: number;
      refreshMs?: number;
      timeoutMs?: number;
    } = {},
  ) {}

  getSnapshot = (id: string): ReferenceState<T> => this.entries.get(id)?.state ?? LOADING;

  subscribe = (id: string, listener: Listener): (() => void) => {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { state: LOADING, listeners: new Set() };
      this.entries.set(id, entry);
      this.queue(id);
    }
    entry.listeners.add(listener);
    const subscribed = entry;
    return () => {
      subscribed.listeners.delete(listener);
      if (subscribed.listeners.size === 0 && this.entries.get(id) === subscribed) {
        clearTimeout(subscribed.refresh);
        this.entries.delete(id);
        this.pending.delete(id);
        const batch = subscribed.inFlight;
        if (batch) {
          // A batch can still serve other visible references.
          batch.entries.delete(subscribed);
          if (batch.entries.size === 0) batch.controller.abort();
        }
      }
    };
  };

  /** Foreground/retry invalidation drops old facts immediately, including on failure. */
  refresh = (): void => {
    for (const [id, entry] of this.entries) {
      if (entry.inFlight) continue;
      clearTimeout(entry.refresh);
      entry.state = LOADING;
      this.emit(entry);
      this.queue(id);
    }
  };

  private emit(entry: Entry<T>): void {
    for (const listener of entry.listeners) listener();
  }

  private queue(id: string): void {
    this.pending.add(id);
    this.scheduled ??= setTimeout(() => {
      this.scheduled = undefined;
      void this.flush();
    }, this.options.batchDelayMs ?? 16);
  }

  private async flush(): Promise<void> {
    const batch = new Map<string, Entry<T>>();
    for (const id of this.pending) {
      const entry = this.entries.get(id);
      if (entry && !entry.inFlight) {
        batch.set(id, entry);
      }
    }
    this.pending.clear();
    if (!batch.size) return;
    const controller = new AbortController();
    const active: ActiveBatch<T> = { controller, entries: new Set(batch.values()) };
    for (const entry of active.entries) entry.inFlight = active;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let values = new Map<string, T>();
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('Reference provider aborted'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8_000);
      });
      const result = await Promise.race([
        this.load([...batch.keys()], { signal: controller.signal }),
        aborted,
      ]);
      // Treat malformed/incomplete batches as unavailable, never as old data.
      const ids = [...result.items.map((item) => item.id), ...result.unavailableIds];
      if (
        ids.length !== batch.size ||
        new Set(ids).size !== batch.size ||
        ids.some((id) => !batch.has(id))
      )
        throw new Error('Invalid reference batch');
      values = new Map(result.items.map((item) => [item.id, item]));
    } catch {
      // No stale fallback; errors deliberately carry no provider facts.
    } finally {
      clearTimeout(timeout);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
    for (const [id, entry] of batch) {
      // A recycled row may now subscribe to the same ID with a new lifetime.
      if (this.entries.get(id) !== entry) continue;
      entry.inFlight = undefined;
      const value = values.get(id);
      entry.state = value ? { status: 'ready', value } : UNAVAILABLE;
      this.emit(entry);
      entry.refresh = setTimeout(() => {
        if (this.entries.get(id) !== entry) return;
        entry.state = LOADING;
        this.emit(entry);
        this.queue(id);
      }, this.options.refreshMs ?? 30_000);
    }
  }
}
