import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The banner re-encoder's ffmpeg invocation: sandboxed exactly like the video
 * poster (`-protocol_whitelist file`, an argument array, a local input), first
 * frame only, bounded edge, WebP — and JPEG only when a WebP run produced
 * nothing (an ffmpeg without `libwebp`).
 */

interface SpawnCall {
  command: string;
  args: string[];
}
const spawnCalls: SpawnCall[] = [];

class FakeChild extends EventEmitter {
  public stdout = new PassThrough();
  public killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

let children: FakeChild[] = [];
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    const child = new FakeChild();
    children.push(child);
    return child;
  },
}));

import {
  buildReencodeArgs,
  reencodeFirstFrame,
  REENCODE_TARGETS,
  REENCODED_MAX_EDGE_PX,
} from '../../utils/imageReencode';

beforeEach(() => {
  spawnCalls.length = 0;
  children = [];
});

/** Let the pending spawn register, then answer it. */
async function answer(index: number, output: Buffer | null, code: number): Promise<void> {
  await vi.waitFor(() => expect(children.length).toBeGreaterThan(index));
  const child = children[index];
  if (output) child.stdout.write(output);
  child.stdout.end();
  child.emit('close', code);
}

describe('buildReencodeArgs', () => {
  const input = '/tmp/mention-media-cache-x/abc.bin';
  const args = buildReencodeArgs(input, REENCODE_TARGETS[0]);

  it('disables networking and reads only the local temp file', () => {
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file');
    expect(args[args.indexOf('-i') + 1]).toBe(input);
    for (const arg of args) expect(arg).not.toMatch(/^https?:\/\//);
  });

  it('takes the FIRST frame, fits it inside the max edge without upscaling, and writes WebP to stdout', () => {
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    const filter = args[args.indexOf('-vf') + 1];
    expect(filter).toContain(`min(${REENCODED_MAX_EDGE_PX},iw)`);
    expect(filter).toContain('force_original_aspect_ratio=decrease');
    expect(args[args.indexOf('-c:v') + 1]).toBe('libwebp');
    expect(args[args.indexOf('-f') + 1]).toBe('webp');
    expect(args[args.length - 1]).toBe('-');
  });
});

describe('reencodeFirstFrame', () => {
  it('returns the WebP still', async () => {
    const result = reencodeFirstFrame('/tmp/in.bin');
    await answer(0, Buffer.from('RIFFxxxxWEBP'), 0);
    await expect(result).resolves.toEqual({
      ok: true,
      buffer: Buffer.from('RIFFxxxxWEBP'),
      contentType: 'image/webp',
    });
    expect(spawnCalls).toHaveLength(1);
  });

  it('falls back to JPEG only when the WebP run produced nothing', async () => {
    const result = reencodeFirstFrame('/tmp/in.bin');
    await answer(0, null, 1);
    await answer(1, Buffer.from([0xff, 0xd8, 0xff]), 0);
    await expect(result).resolves.toMatchObject({ ok: true, contentType: 'image/jpeg' });
    expect(spawnCalls[1].args[spawnCalls[1].args.indexOf('-c:v') + 1]).toBe('mjpeg');
  });

  it('answers undecodable when no encoder can decode the input', async () => {
    const result = reencodeFirstFrame('/tmp/in.bin');
    await answer(0, null, 1);
    await answer(1, null, 1);
    await expect(result).resolves.toEqual({ ok: false, reason: 'undecodable' });
  });

  it('does not retry an ffmpeg that could not run at all', async () => {
    const result = reencodeFirstFrame('/tmp/in.bin');
    await vi.waitFor(() => expect(children.length).toBe(1));
    children[0].emit('error', new Error('ENOENT'));
    await expect(result).resolves.toEqual({ ok: false, reason: 'spawn-failed' });
    expect(spawnCalls).toHaveLength(1);
  });
});
