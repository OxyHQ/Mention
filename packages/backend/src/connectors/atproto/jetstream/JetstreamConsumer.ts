/**
 * A long-running Jetstream subscription that feeds record commits to collection
 * handlers in batches and keeps a durable resume cursor.
 *
 * ## One connection, filtered by collection, never by account
 *
 * It subscribes to the union of its handlers' collections and filters accounts
 * itself. Jetstream can filter by `dids` server-side, but the public instances
 * sit behind a proxy that refuses a request line over about 8 KB (measured:
 * 414 at ~215 DIDs), so a DID filter caps a connection at ~200 accounts, not
 * the 10,000 the lexicon allows. A DID-filtered design would need dozens of
 * connections, re-sharding and a reconnect on every follow. And the handlers
 * that are coming next cannot be expressed as a DID filter at all: a like or a
 * follow is relevant when its SUBJECT is ours, and its author can be anyone.
 * The full post stream is ~70 events/s (~65 KB/s), which is cheap to read and
 * discard.
 *
 * ## The cursor only covers work that is done
 *
 * Frames are parsed as they arrive; commits for a handled collection are queued
 * and handed to the handlers every `flushIntervalMs`, in stream order, grouped
 * by collection. After a batch has been handled, the cursor of the newest frame
 * received before the batch was taken is the resume position, saved at most
 * every `cursorSaveIntervalMs` and on stop. A handler that throws (the AppView
 * down, the database unreachable) does not advance it: the connection is
 * dropped and re-opened from the last good cursor, so the batch is delivered
 * again instead of being lost. That is also the backpressure: a queue that
 * outgrows `maxPendingCommits` reconnects rather than growing.
 *
 * Reconnects back off exponentially (`reconnect*` options), reset once a
 * connection has stayed up, and move to the next of the `endpoints` each time,
 * so one degraded Jetstream instance is left behind (the timestamp cursor is
 * valid on every instance).
 *
 * ## A stream that falls behind live is a dead stream
 *
 * A Jetstream instance can stay connected while delivering a trickle of old
 * events (seen on us-east, 2026-11-04: 1 event/s against 50/s on us-west, then
 * nothing). Silence alone does not catch that, so the watchdog asks a stronger
 * question every `stallWindowMs`: did the stream's own clock (the newest
 * `witnessedAt` received) advance by at least half the wall-clock time that
 * passed? A live tail advances one-for-one and a replay faster; a stream that
 * cannot keep pace with real time will never catch up, and is reconnected
 * elsewhere. The post collection is always subscribed, so a healthy stream is
 * never quiet for minutes.
 */

import { logger } from '../../../utils/logger';
import { type JetstreamCommit, parseFrame, subscribeUrl } from './protocol';

/**
 * A handler for one record collection. It receives every commit of that
 * collection — creates, updates and deletes, from every account — in stream
 * order, and decides itself which are relevant. Delivery is at-least-once, so a
 * handler must be idempotent on `commit.uri`. Throwing makes the consumer
 * re-deliver the batch later; a handler should throw only for a failure that may
 * pass.
 */
export interface JetstreamCollectionHandler {
  /** The record collection's NSID, e.g. `app.bsky.feed.post`. */
  readonly collection: string;
  handle(commits: readonly JetstreamCommit[]): Promise<void>;
}

/** The durable resume position. */
export interface JetstreamCursorStore {
  read(): Promise<number | undefined>;
  write(cursor: number): Promise<void>;
}

/** A WebSocket, reduced to what the consumer uses (injected by tests). */
export interface JetstreamTransport {
  connect(
    url: string,
    events: {
      onOpen(): void;
      onMessage(text: string): void;
      onClose(code: number, reason: string): void;
    },
  ): { close(): void };
}

/** The runtime's WHATWG WebSocket (Bun, Node ≥ 22). */
export const webSocketTransport: JetstreamTransport = {
  connect(url, events) {
    const socket = new WebSocket(url);
    socket.onopen = () => events.onOpen();
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') events.onMessage(event.data);
    };
    // Every error is followed by a close, which is where reconnecting happens.
    socket.onerror = () => undefined;
    socket.onclose = (event) => events.onClose(event.code, event.reason);
    return { close: () => socket.close() };
  },
};

export interface JetstreamConsumerOptions {
  /** Jetstream v2 origins, tried in order and rotated on every reconnect. */
  endpoints: readonly string[];
  handlers: readonly JetstreamCollectionHandler[];
  cursors: JetstreamCursorStore;
  transport?: JetstreamTransport;
  flushIntervalMs?: number;
  cursorSaveIntervalMs?: number;
  maxPendingCommits?: number;
  stallWindowMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

const DEFAULTS = {
  flushIntervalMs: 1_000,
  cursorSaveIntervalMs: 5_000,
  maxPendingCommits: 5_000,
  stallWindowMs: 2 * 60_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 60_000,
};

/** How long {@link JetstreamConsumer.stop} waits for an in-flight batch. */
const STOP_DRAIN_MS = 5_000;

/** A connection that stayed up this long resets the reconnect backoff. */
const STABLE_CONNECTION_MS = 60_000;

export class JetstreamConsumer {
  private readonly handlers: ReadonlyMap<string, JetstreamCollectionHandler>;
  private readonly options: typeof DEFAULTS & JetstreamConsumerOptions;
  private readonly transport: JetstreamTransport;

  private running = false;
  private connection: { close(): void } | undefined;
  /** Bumped per connection, so a late event from a closed one is ignored. */
  private generation = 0;
  private openedAt: number | undefined;
  private endpointIndex = 0;
  /** Where the stream's clock stood at the start of the current stall window. */
  private stallCheck: { at: number; cursor: number | undefined } = { at: 0, cursor: undefined };
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  private pending: JetstreamCommit[] = [];
  /** The newest frame received on the current connection. */
  private receivedCursor: number | undefined;
  /** Everything up to here has been handled. */
  private handledCursor: number | undefined;
  private savedCursor: number | undefined;
  private savedAt = 0;
  private flushing: Promise<void> | undefined;

  constructor(options: JetstreamConsumerOptions) {
    const handlers = new Map<string, JetstreamCollectionHandler>();
    for (const handler of options.handlers) {
      if (handlers.has(handler.collection)) {
        throw new Error(`Two Jetstream handlers for ${handler.collection}`);
      }
      handlers.set(handler.collection, handler);
    }
    this.handlers = handlers;
    this.options = { ...DEFAULTS, ...options };
    this.transport = options.transport ?? webSocketTransport;
  }

  /** Read the saved cursor and connect. Resolves once the first connection is opening. */
  async start(): Promise<void> {
    if (this.running || this.handlers.size === 0) return;
    this.running = true;
    this.savedCursor = await this.options.cursors.read();
    this.handledCursor = this.savedCursor;
    this.flushTimer = setInterval(() => void this.tick(), this.options.flushIntervalMs);
    this.flushTimer.unref?.();
    this.connect();
  }

  /** Disconnect, let an in-flight batch finish, and save how far it got. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.flushTimer);
    clearTimeout(this.reconnectTimer);
    this.generation += 1;
    this.connection?.close();
    this.connection = undefined;
    // Bounded: shutdown has its own deadline. A batch still running when this
    // gives up has not moved the cursor, so it is simply delivered again.
    let drained: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.flushing,
      new Promise<void>((resolve) => {
        drained = setTimeout(resolve, STOP_DRAIN_MS);
      }),
    ]);
    clearTimeout(drained);
    await this.saveCursor(true);
  }

  /**
   * Hand every queued commit to its handler and advance the cursor past them.
   * Single-flight; also what the flush timer calls.
   */
  flush(): Promise<void> {
    this.flushing ??= this.runFlush().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private connect(): void {
    if (!this.running) return;
    const generation = ++this.generation;
    this.pending = [];
    this.receivedCursor = undefined;
    this.openedAt = undefined;
    this.stallCheck = { at: Date.now(), cursor: undefined };
    const endpoint = this.options.endpoints[this.endpointIndex % this.options.endpoints.length];
    const url = subscribeUrl(endpoint, [...this.handlers.keys()], this.handledCursor);
    logger.info('[jetstream] connecting', { endpoint, resumes: this.handledCursor !== undefined });
    this.connection = this.transport.connect(url, {
      onOpen: () => {
        if (generation === this.generation) this.openedAt = Date.now();
      },
      onMessage: (text) => {
        if (generation === this.generation) this.receive(text);
      },
      onClose: (code, reason) => {
        if (generation === this.generation) this.disconnected(code, reason);
      },
    });
  }

  private receive(text: string): void {
    const frame = parseFrame(text);
    switch (frame.kind) {
      case 'commit': {
        this.receivedCursor = frame.commit.cursor;
        if (!this.handlers.has(frame.commit.collection)) return;
        this.pending.push(frame.commit);
        if (this.pending.length > this.options.maxPendingCommits) {
          this.reconnect('handlers are falling behind');
        }
        return;
      }
      case 'info':
        // OutdatedCursor: the outage outlasted the replay window and events in
        // between are gone; the periodic author-feed sync is what covers them.
        logger.warn('[jetstream] stream notice', { name: frame.name, message: frame.message });
        return;
      case 'error':
        logger.warn('[jetstream] stream error', { error: frame.error, message: frame.message });
        return;
      case 'ignored':
        return;
    }
  }

  private async runFlush(): Promise<void> {
    const batch = this.pending;
    const upTo = this.receivedCursor;
    const generation = this.generation;
    this.pending = [];
    try {
      const byCollection = new Map<string, JetstreamCommit[]>();
      for (const commit of batch) {
        const group = byCollection.get(commit.collection);
        if (group) group.push(commit);
        else byCollection.set(commit.collection, [commit]);
      }
      for (const [collection, commits] of byCollection) {
        await this.handlers.get(collection)?.handle(commits);
      }
    } catch (err) {
      logger.warn('[jetstream] handler failed; replaying from the last cursor', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Only the connection this batch came from: anything it queued since is
      // after the failure and must be replayed too.
      if (generation === this.generation) this.reconnect('handler failed');
      return;
    }
    // Everything received up to `upTo` was either in this batch or for no handler.
    if (upTo !== undefined) this.handledCursor = upTo;
    await this.saveCursor(false);
  }

  private async saveCursor(force: boolean): Promise<void> {
    const cursor = this.handledCursor;
    if (cursor === undefined || cursor === this.savedCursor) return;
    if (!force && Date.now() - this.savedAt < this.options.cursorSaveIntervalMs) return;
    try {
      await this.options.cursors.write(cursor);
      this.savedCursor = cursor;
      this.savedAt = Date.now();
    } catch (err) {
      logger.warn('[jetstream] cursor save failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async tick(): Promise<void> {
    if (this.connection && this.isStalled()) {
      this.reconnect('stream is falling behind live');
      return;
    }
    await this.flush();
  }

  /**
   * True once a whole stall window passed in which the stream's clock advanced by
   * less than half of it (or not at all). Starts a new window either way.
   */
  private isStalled(): boolean {
    const now = Date.now();
    const elapsed = now - this.stallCheck.at;
    if (elapsed < this.options.stallWindowMs) return false;
    const from = this.stallCheck.cursor;
    const to = this.receivedCursor;
    this.stallCheck = { at: now, cursor: to };
    if (to === undefined) return true;
    // The window's first frame sets its baseline; judge the next window.
    if (from === undefined) return false;
    return (to - from) / 1_000 < elapsed / 2;
  }

  /** Drop the current connection; {@link disconnected} schedules the next one. */
  private reconnect(reason: string): void {
    const connection = this.connection;
    if (!connection) return;
    logger.info('[jetstream] reconnecting', { reason });
    this.disconnected(undefined, reason);
    connection.close();
  }

  private disconnected(code: number | undefined, reason: string): void {
    this.generation += 1;
    this.connection = undefined;
    // What was queued or seen on this connection is replayed by the next one,
    // so none of it may move the cursor.
    this.pending = [];
    this.receivedCursor = undefined;
    if (!this.running) return;
    if (this.openedAt !== undefined && Date.now() - this.openedAt >= STABLE_CONNECTION_MS) {
      this.reconnectAttempt = 0;
    }
    const base = Math.min(
      this.options.reconnectBaseMs * 2 ** this.reconnectAttempt,
      this.options.reconnectMaxMs,
    );
    const delay = base + Math.floor(Math.random() * base * 0.25);
    this.reconnectAttempt += 1;
    this.endpointIndex += 1;
    logger.info('[jetstream] disconnected', { code, reason, retryInMs: delay });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      // A batch from the old connection may still be running; resume after it.
      void (this.flushing ?? Promise.resolve()).then(() => this.connect());
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
