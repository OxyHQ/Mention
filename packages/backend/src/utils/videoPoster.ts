import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger';

/**
 * Extract a single JPEG poster frame from a remote video, with ffmpeg fully
 * sandboxed away from the network.
 *
 * SECURITY MODEL — ffmpeg never touches the network:
 *   1. The caller fetches a bounded byte prefix of the (already SSRF-validated)
 *      remote video and hands us the raw bytes.
 *   2. We persist those bytes to a private temp file and invoke ffmpeg ONLY on
 *      that local file.
 *   3. ffmpeg is launched with `-protocol_whitelist file` (NOT http/https/tcp/
 *      tls/crypto), so even a crafted container that references an external
 *      `http://…` segment (HLS/DASH) or a local path (`file:///etc/passwd`)
 *      cannot be opened — ffmpeg has no protocol with which to reach anything
 *      beyond the single input file we pass. This closes both ffmpeg-driven SSRF
 *      and local-file disclosure.
 *   4. The command is built as an ARGUMENT ARRAY passed to `spawn` (no shell),
 *      so the remote-controlled bytes never reach a shell for interpretation.
 *
 * Operational bounds: a hard wall-clock timeout kills a stuck/zip-bomb decode,
 * and stdout is capped so a pathological encode cannot exhaust memory. The temp
 * file is always removed in a `finally`.
 */

/** Absolute path to the ffmpeg binary. Overridable for non-standard images. */
const FFMPEG_BINARY = process.env.FFMPEG_PATH ?? 'ffmpeg';

/** Hard wall-clock ceiling for a single ffmpeg decode before we SIGKILL it. */
const FFMPEG_TIMEOUT_MS = 10_000;

/**
 * Cap on the JPEG bytes we will buffer from ffmpeg stdout. A single downscaled
 * frame is far smaller than this; the cap defends against a pathological encode
 * streaming unbounded output.
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024; // 8 MiB

/** Number of bytes of randomness in the temp filename (collision resistance). */
const TEMP_NAME_RANDOM_BYTES = 16;

/** Prefix for the per-extraction temp directory created under the OS tmpdir. */
const TEMP_DIR_PREFIX = 'mention-poster-';

/**
 * Maximum output frame width. ffmpeg downscales to at most this width preserving
 * aspect ratio (`-2` keeps height even for the encoder), never upscaling.
 */
const MAX_FRAME_WIDTH = 720;

/**
 * ffmpeg argument array (NEVER a shell string).
 *
 * - `-protocol_whitelist file`: the ONLY protocol ffmpeg may use is the local
 *   file protocol — no http/https/tcp/tls/crypto. ffmpeg cannot fetch anything.
 * - `-i <inputPath>`: the single local temp file (the buffered video prefix).
 * - `-frames:v 1`: decode exactly one video frame.
 * - `-vf scale=...`: downscale to at most MAX_FRAME_WIDTH, keep aspect ratio.
 * - `-f image2 -`: emit a single JPEG image to stdout.
 * - `-loglevel error -nostdin`: quiet, and never block waiting on stdin.
 */
export function buildFfmpegArgs(inputPath: string): string[] {
  return [
    '-loglevel',
    'error',
    '-nostdin',
    '-protocol_whitelist',
    'file',
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${MAX_FRAME_WIDTH},iw)':-2`,
    '-f',
    'image2',
    '-',
  ];
}

/** Result of a poster extraction attempt. */
export type PosterResult =
  | { ok: true; jpeg: Buffer }
  | { ok: false; reason: 'no-frame' | 'timeout' | 'output-too-large' | 'spawn-failed' };

/**
 * Run ffmpeg on a local temp file holding `videoPrefix` and return one JPEG
 * frame. Pure with respect to the network: the only file ffmpeg can read is the
 * temp file we write here, and it has no protocol to reach anything else.
 *
 * The exported {@link buildFfmpegArgs} and {@link FFMPEG_BINARY} make the exact
 * invocation auditable/testable (the test asserts `-protocol_whitelist file`
 * and the arg-array shape, and that no network URL is ever passed to ffmpeg).
 */
export async function extractPosterFrame(videoPrefix: Buffer): Promise<PosterResult> {
  // Per-extraction directory so concurrent requests never collide and cleanup
  // is a single recursive remove regardless of what ffmpeg may write.
  const dir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  const inputPath = join(dir, `${randomBytes(TEMP_NAME_RANDOM_BYTES).toString('hex')}.bin`);

  try {
    await writeFile(inputPath, videoPrefix);
    return await runFfmpeg(inputPath);
  } finally {
    // Always remove the temp directory and its contents. `force` swallows a
    // missing-path race; failure to clean up is logged, never thrown.
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
      logger.warn('[VideoPoster] Failed to remove temp dir', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    });
  }
}

/** Spawn ffmpeg against the local file and collect a bounded JPEG from stdout. */
function runFfmpeg(inputPath: string): Promise<PosterResult> {
  return new Promise<PosterResult>((resolve) => {
    const args = buildFfmpegArgs(inputPath);

    let child: ReturnType<typeof spawn>;
    try {
      // Arg array + no shell: remote bytes never reach a shell. stdin is closed
      // so ffmpeg can never block on it; stderr is ignored (loglevel error).
      child = spawn(FFMPEG_BINARY, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      logger.warn('[VideoPoster] ffmpeg spawn threw', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      resolve({ ok: false, reason: 'spawn-failed' });
      return;
    }

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const settle = (result: PosterResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // Hard wall-clock ceiling: SIGKILL a stuck/oversized decode.
    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      logger.warn('[VideoPoster] ffmpeg timed out', { timeoutMs: FFMPEG_TIMEOUT_MS });
      settle({ ok: false, reason: 'timeout' });
    }, FFMPEG_TIMEOUT_MS);

    child.on('error', (error: Error) => {
      logger.warn('[VideoPoster] ffmpeg process error', { reason: error.message });
      settle({ ok: false, reason: 'spawn-failed' });
    });

    const stdout = child.stdout;
    if (stdout === null) {
      // Should not happen with stdio 'pipe', but fail closed rather than hang.
      if (!child.killed) child.kill('SIGKILL');
      settle({ ok: false, reason: 'spawn-failed' });
      return;
    }

    stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        if (!child.killed) child.kill('SIGKILL');
        logger.warn('[VideoPoster] ffmpeg output exceeded cap', { outputBytes });
        settle({ ok: false, reason: 'output-too-large' });
        return;
      }
      chunks.push(chunk);
    });

    child.on('close', (code: number | null) => {
      // A non-zero exit, or a clean exit with no decoded frame (e.g. the moov
      // atom sits at the end of a non-faststart MP4 so the prefix has no
      // decodable frame), yields no usable poster.
      if (code !== 0 || chunks.length === 0) {
        settle({ ok: false, reason: 'no-frame' });
        return;
      }
      settle({ ok: true, jpeg: Buffer.concat(chunks) });
    });
  });
}
