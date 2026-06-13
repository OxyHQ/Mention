import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Captures every `spawn` invocation so we can assert ffmpeg's exact command
 * line — specifically that networking is disabled (`-protocol_whitelist file`),
 * that the command is an ARGUMENT ARRAY (never a shell string), and that ffmpeg
 * is only ever pointed at a LOCAL temp file, never a network URL.
 */
interface SpawnCall {
  command: string;
  args: string[];
}

const spawnCalls: SpawnCall[] = [];

/** A controllable fake child process backed by real EventEmitter + stream. */
class FakeChild extends EventEmitter {
  public stdout = new PassThrough();
  public killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

let nextChild: FakeChild;

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    return nextChild;
  },
}));

import { extractPosterFrame, buildFfmpegArgs } from '../../utils/videoPoster';

beforeEach(() => {
  spawnCalls.length = 0;
  nextChild = new FakeChild();
});

// --- buildFfmpegArgs: the security-critical command shape -------------------

describe('buildFfmpegArgs', () => {
  const inputPath = '/tmp/mention-poster-abc/deadbeef.bin';

  it('disables networking via -protocol_whitelist file (no http/https/tcp/tls)', () => {
    const args = buildFfmpegArgs(inputPath);
    const idx = args.indexOf('-protocol_whitelist');
    expect(idx).toBeGreaterThanOrEqual(0);
    // The whitelist value must be EXACTLY "file" — nothing network-capable.
    expect(args[idx + 1]).toBe('file');
    expect(args[idx + 1]).not.toMatch(/http|https|tcp|tls|crypto/);
  });

  it('passes the local temp file as the only input, never a network URL', () => {
    const args = buildFfmpegArgs(inputPath);
    const iIdx = args.indexOf('-i');
    expect(iIdx).toBeGreaterThanOrEqual(0);
    expect(args[iIdx + 1]).toBe(inputPath);
    // No argument anywhere may carry a network URL.
    for (const arg of args) {
      expect(arg).not.toMatch(/^https?:\/\//);
    }
  });

  it('decodes a single frame and emits one image to stdout', () => {
    const args = buildFfmpegArgs(inputPath);
    expect(args).toContain('-frames:v');
    expect(args[args.indexOf('-frames:v') + 1]).toBe('1');
    expect(args).toContain('-f');
    expect(args[args.indexOf('-f') + 1]).toBe('image2');
    // Output goes to stdout (the trailing "-").
    expect(args[args.length - 1]).toBe('-');
  });
});

// --- extractPosterFrame: spawn invocation + result handling -----------------

describe('extractPosterFrame', () => {
  it('invokes ffmpeg as an arg array against a local temp file with the network disabled', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // JPEG SOI marker

    const promise = extractPosterFrame(Buffer.from('fake video prefix bytes'));

    // Let the temp file write + spawn happen, then drive the fake child.
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1));

    const call = spawnCalls[0];
    expect(call.command).toBe('ffmpeg');
    expect(Array.isArray(call.args)).toBe(true);

    // Network is disabled.
    const wlIdx = call.args.indexOf('-protocol_whitelist');
    expect(call.args[wlIdx + 1]).toBe('file');

    // The input is a real local path under the OS tmpdir — NOT a network URL.
    const inputPath = call.args[call.args.indexOf('-i') + 1];
    expect(inputPath.startsWith(tmpdir())).toBe(true);
    expect(inputPath).not.toMatch(/^https?:\/\//);

    // Emit one frame, then a clean exit.
    nextChild.stdout.write(jpeg);
    nextChild.stdout.end();
    nextChild.emit('close', 0);

    const result = await promise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.jpeg.equals(jpeg)).toBe(true);
    }
  });

  it('returns no-frame when ffmpeg exits cleanly but produced no output', async () => {
    const promise = extractPosterFrame(Buffer.from('no decodable frame in this prefix'));
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1));

    // Non-faststart MP4 case: clean exit, but no frame decoded from the prefix.
    nextChild.stdout.end();
    nextChild.emit('close', 0);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-frame');
  });

  it('returns no-frame on a non-zero ffmpeg exit code', async () => {
    const promise = extractPosterFrame(Buffer.from('corrupt'));
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1));

    nextChild.stdout.end();
    nextChild.emit('close', 1);

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-frame');
  });
});
