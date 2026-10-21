import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import { startSseKeepAlive } from '../lib/sse-keepalive.js';
import { delay } from './support/spawn-server.js';

class FakeResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  readonly chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe('legacy SSE keep-alive', () => {
  test('writes an SSE comment on every interval until the response closes', async () => {
    const res = new FakeResponse();
    startSseKeepAlive(res, 10);

    await delay(35);
    expect(res.chunks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(res.chunks)).toEqual(new Set([': keep-alive\n\n']));

    res.emit('close');
    const written = res.chunks.length;
    await delay(30);
    expect(res.chunks.length).toBe(written);
  });

  test('never writes to a response that already ended', async () => {
    const res = new FakeResponse();
    res.writableEnded = true;
    startSseKeepAlive(res, 10);

    await delay(30);
    expect(res.chunks).toEqual([]);
  });
});
