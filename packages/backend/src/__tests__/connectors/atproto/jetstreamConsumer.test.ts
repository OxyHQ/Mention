import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Jetstream consumer against a fake stream: commits reach their collection's
 * handler in order, the cursor is saved only past handled work, a restart
 * resumes from the saved cursor, and a batch whose handler threw is delivered
 * again from the last good cursor.
 */

import {
  JetstreamConsumer,
  type JetstreamCollectionHandler,
  type JetstreamTransport,
} from '../../../connectors/atproto/jetstream/JetstreamConsumer';
import type { JetstreamCommit } from '../../../connectors/atproto/jetstream/protocol';

const DID = 'did:plc:jetstreamconsumertest00000';
const BASE_MICROS = 1_793_800_000_000_000;

/** A Jetstream v2 commit frame, witnessed `offset` µs after the base time. */
function commitFrame(
  offset: number,
  operation: 'create' | 'delete',
  rkey: string,
  collection = 'app.bsky.feed.post',
): string {
  const micros = BASE_MICROS + offset;
  const seconds = Math.floor(micros / 1_000_000);
  const fraction = String(micros % 1_000_000).padStart(6, '0');
  const witnessedAt = `${new Date(seconds * 1_000).toISOString().slice(0, 19)}.${fraction}Z`;
  return JSON.stringify({
    $type: 'message',
    payload: {
      $type: 'network.bsky.jetstream.subscribeEvents#commit',
      did: DID,
      seq: offset,
      time: witnessedAt,
      witnessedAt,
      rev: '3mzijhlztdt2c',
      operation,
      collection,
      rkey,
      ...(operation === 'create'
        ? { cid: 'bafyrei', record: { $type: collection, text: rkey } }
        : {}),
    },
  });
}

/** A transport that records every connection and lets the test push frames into the open one. */
function fakeTransport() {
  const connections: Array<{
    url: string;
    send(text: string): void;
    drop(): void;
  }> = [];
  const transport: JetstreamTransport = {
    connect(url, events) {
      connections.push({
        url,
        send: (text) => events.onMessage(text),
        drop: () => events.onClose(1006, 'gone'),
      });
      events.onOpen();
      return { close: () => undefined };
    },
  };
  return { transport, connections };
}

function recordingHandler(
  collection = 'app.bsky.feed.post',
): JetstreamCollectionHandler & { batches: JetstreamCommit[][] } {
  const batches: JetstreamCommit[][] = [];
  return {
    collection,
    batches,
    handle: vi.fn(async (commits: readonly JetstreamCommit[]) => {
      batches.push([...commits]);
    }),
  };
}

function memoryCursors(initial?: number) {
  const store = { value: initial, writes: [] as number[] };
  return {
    store,
    cursors: {
      read: async () => store.value,
      write: async (cursor: number) => {
        store.value = cursor;
        store.writes.push(cursor);
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('JetstreamConsumer', () => {
  it('hands creates and deletes to their handler in order and saves the cursor after', async () => {
    const { transport, connections } = fakeTransport();
    const handler = recordingHandler();
    const { store, cursors } = memoryCursors();
    const consumer = new JetstreamConsumer({
      endpoint: 'wss://jetstream.test',
      handlers: [handler],
      cursors,
      transport,
      cursorSaveIntervalMs: 0,
    });

    await consumer.start();
    expect(connections[0].url).toBe(
      'wss://jetstream.test/xrpc/network.bsky.jetstream.subscribeEvents?kinds=commit&collections=app.bsky.feed.post',
    );

    connections[0].send(commitFrame(1, 'create', 'one'));
    connections[0].send(commitFrame(2, 'delete', 'zero'));
    connections[0].send('{"$type":"message","payload":{"$type":"something#else"}}');
    await consumer.flush();

    expect(handler.batches).toHaveLength(1);
    expect(handler.batches[0].map((c) => [c.operation, c.uri])).toEqual([
      ['create', `at://${DID}/app.bsky.feed.post/one`],
      ['delete', `at://${DID}/app.bsky.feed.post/zero`],
    ]);
    expect(store.value).toBe(BASE_MICROS + 2);
    await consumer.stop();
  });

  it('resumes from the saved cursor, and replays a batch whose handler failed', async () => {
    const { transport, connections } = fakeTransport();
    const handler = recordingHandler();
    const { store, cursors } = memoryCursors(BASE_MICROS);
    const consumer = new JetstreamConsumer({
      endpoint: 'wss://jetstream.test',
      handlers: [handler],
      cursors,
      transport,
      cursorSaveIntervalMs: 0,
      reconnectBaseMs: 10,
    });

    await consumer.start();
    expect(new URL(connections[0].url).searchParams.get('cursor')).toBe(String(BASE_MICROS));

    vi.mocked(handler.handle).mockRejectedValueOnce(new Error('appview down'));
    connections[0].send(commitFrame(5, 'create', 'five'));
    await consumer.flush();
    expect(store.writes).toEqual([]);

    // The failed connection is replaced, from the cursor before the failed batch.
    await vi.advanceTimersByTimeAsync(50);
    expect(connections).toHaveLength(2);
    expect(new URL(connections[1].url).searchParams.get('cursor')).toBe(String(BASE_MICROS));

    connections[1].send(commitFrame(5, 'create', 'five'));
    await consumer.flush();
    expect(handler.handle).toHaveBeenCalledTimes(2);
    expect(handler.batches.map((batch) => batch.map((c) => c.rkey))).toEqual([['five']]);
    expect(store.value).toBe(BASE_MICROS + 5);

    // A dropped connection resumes from what was handled.
    connections[1].drop();
    await vi.advanceTimersByTimeAsync(50);
    expect(new URL(connections[2].url).searchParams.get('cursor')).toBe(String(BASE_MICROS + 5));
    await consumer.stop();
  });
});
