import type { NotificationIntent } from '@/types/notificationIntent';

type Subscribe = (listener: () => void) => () => void;
type Current = (intent: NotificationIntent) => boolean;

type Entry = {
  intent: NotificationIntent;
  controller: AbortController;
  release: () => void;
};

/**
 * Owns a surface through physical closure, which may follow its result.
 * The view supplies the current session predicate and subscription source.
 */
export class NotificationSurfaceOwner {
  private active = false;
  private readonly entries = new Set<Entry>();

  constructor(
    private isCurrent: Current,
    private subscribe: Subscribe,
  ) {}

  activate(): void {
    this.active = true;
  }

  update(isCurrent: Current, subscribe: Subscribe): void {
    const sourceChanged = this.subscribe !== subscribe;
    this.isCurrent = isCurrent;
    this.subscribe = subscribe;
    for (const entry of this.entries) {
      if (sourceChanged || !isCurrent(entry.intent)) this.abort(entry);
    }
  }

  dispose(): void {
    this.active = false;
    for (const entry of this.entries) this.abort(entry);
  }

  async open<Result>(
    intent: NotificationIntent,
    present: (signal: AbortSignal, onClosed: () => void) => Promise<Result>,
  ): Promise<Result | undefined> {
    if (!this.active || !this.isCurrent(intent)) return undefined;
    const controller = new AbortController();
    let unsubscribe: (() => void) | undefined;
    let released = false;
    const entry: Entry = {
      intent,
      controller,
      release: () => {
        if (released) return;
        released = true;
        this.entries.delete(entry);
        unsubscribe?.();
      },
    };
    this.entries.add(entry);
    try {
      const releaseSubscription = this.subscribe(() => {
        if (!this.active || !this.isCurrent(intent)) this.abort(entry);
      });
      unsubscribe = releaseSubscription;
      // An initial subscription may synchronously invalidate its own lease.
      if (released) releaseSubscription();
      if (!this.active || !this.isCurrent(intent)) this.abort(entry);
      if (controller.signal.aborted) return undefined;
      const result = await present(controller.signal, entry.release);
      return this.active && !controller.signal.aborted && this.isCurrent(intent)
        ? result
        : undefined;
    } catch (error) {
      this.abort(entry);
      throw error;
    }
  }

  private abort(entry: Entry): void {
    entry.controller.abort();
    entry.release();
  }
}
