import { spawn } from 'node:child_process';
import { config } from '../config';
import { logger } from './logger';

/**
 * Re-encode a downloaded image as a single still, bounded in size: the FIRST
 * frame, scaled to fit inside {@link REENCODED_MAX_EDGE_PX}, as WebP.
 *
 * Used for a federated banner that cannot be stored as-is — larger than the
 * stored cap, animated, or in a format browsers do not render (HEIC, BMP,
 * TIFF) — so it is kept as a header image instead of being dropped.
 *
 * It runs the ffmpeg the runtime image already ships (the backend has no image
 * library), under the same sandbox as `videoPoster.ts`: the input is a LOCAL
 * temp file the caller downloaded through the SSRF-guarded fetcher,
 * `-protocol_whitelist file` leaves ffmpeg no protocol to reach anything else,
 * the command is an argument array (no shell), a wall-clock timeout kills a
 * decode bomb, and stdout is capped.
 *
 * WebP needs ffmpeg's `libwebp` encoder. Should a build lack it, the frame is
 * encoded as JPEG (`mjpeg` is built into every ffmpeg) rather than the banner
 * being lost to a packaging detail.
 */

/** Longest edge of a re-encoded banner. A header renders at most ~1500 px wide. */
export const REENCODED_MAX_EDGE_PX = 1920;

/** Hard wall-clock ceiling for one decode + encode. */
const REENCODE_TIMEOUT_MS = 20_000;

/** Cap on the bytes buffered from ffmpeg's stdout. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** The encoders tried, in order, and the type each produces. */
export const REENCODE_TARGETS = [
  { codec: 'libwebp', format: 'webp', contentType: 'image/webp', quality: ['-quality', '85'] },
  { codec: 'mjpeg', format: 'image2', contentType: 'image/jpeg', quality: ['-q:v', '3'] },
] as const;

type ReencodeTarget = (typeof REENCODE_TARGETS)[number];

export type ReencodeResult =
  | { ok: true; buffer: Buffer; contentType: string }
  | { ok: false; reason: 'undecodable' | 'timeout' | 'output-too-large' | 'spawn-failed' };

/** The ffmpeg argument array for one target (NEVER a shell string). */
export function buildReencodeArgs(inputPath: string, target: ReencodeTarget): string[] {
  const edge = REENCODED_MAX_EDGE_PX;
  return [
    '-loglevel', 'error',
    '-nostdin',
    '-protocol_whitelist', 'file',
    '-i', inputPath,
    '-frames:v', '1',
    // Fit inside edge x edge, keep the aspect ratio, never upscale.
    '-vf', `scale=w='min(${edge},iw)':h='min(${edge},ih)':force_original_aspect_ratio=decrease`,
    '-c:v', target.codec,
    ...target.quality,
    '-f', target.format,
    '-',
  ];
}

function runOnce(inputPath: string, target: ReencodeTarget): Promise<ReencodeResult> {
  return new Promise<ReencodeResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.media.ffmpegPath, buildReencodeArgs(inputPath, target), {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (error) {
      logger.warn('[ImageReencode] ffmpeg spawn threw', { reason: error instanceof Error ? error.message : 'unknown' });
      resolve({ ok: false, reason: 'spawn-failed' });
      return;
    }

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const settle = (result: ReencodeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      logger.warn('[ImageReencode] ffmpeg timed out', { timeoutMs: REENCODE_TIMEOUT_MS });
      settle({ ok: false, reason: 'timeout' });
    }, REENCODE_TIMEOUT_MS);

    child.on('error', (error: Error) => {
      logger.warn('[ImageReencode] ffmpeg process error', { reason: error.message });
      settle({ ok: false, reason: 'spawn-failed' });
    });
    const stdout = child.stdout;
    if (stdout === null) {
      if (!child.killed) child.kill('SIGKILL');
      settle({ ok: false, reason: 'spawn-failed' });
      return;
    }
    stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        if (!child.killed) child.kill('SIGKILL');
        settle({ ok: false, reason: 'output-too-large' });
        return;
      }
      chunks.push(chunk);
    });
    child.on('close', (code: number | null) => {
      if (code !== 0 || chunks.length === 0) {
        settle({ ok: false, reason: 'undecodable' });
        return;
      }
      settle({ ok: true, buffer: Buffer.concat(chunks), contentType: target.contentType });
    });
  });
}

/**
 * The first frame of the image at `inputPath` as a bounded still. Tries WebP,
 * then JPEG only when the WebP run failed to produce anything (an ffmpeg built
 * without `libwebp`); a timeout or an over-cap output is final.
 */
export async function reencodeFirstFrame(inputPath: string): Promise<ReencodeResult> {
  let last: ReencodeResult = { ok: false, reason: 'undecodable' };
  for (const target of REENCODE_TARGETS) {
    last = await runOnce(inputPath, target);
    if (last.ok || last.reason === 'timeout' || last.reason === 'output-too-large' || last.reason === 'spawn-failed') {
      return last;
    }
  }
  return last;
}
