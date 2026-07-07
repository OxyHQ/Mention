import { Router, Response } from 'express';
import { IncomingMessage } from 'node:http';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { OxyServices } from '@oxyhq/core';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';

import { logger } from '../utils/logger';
import { RedisStore } from '../middleware/rateLimitStore';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import {
  SsrfRejection,
  UpstreamResult,
  contentTypeFamily,
  fetchUpstreamFollowingRedirects,
} from '../utils/safeUpstreamFetch';
import { MEDIA_REJECTED_TYPES } from '../services/mediaCache/mediaTypes';

/**
 * POST /posts/intent-media
 *
 * Authenticated. Fetches a REMOTE http(s) media URL (from a compose intent
 * `mediaUrl=` parameter) through the SAME SSRF-safe upstream contract the media
 * proxy uses (`fetchUpstreamFollowingRedirects` → `assertSafePublicUrl` on every
 * hop, connection pinned to the validated IP), enforces an image/video
 * content-type allowlist, then uploads the bytes to Oxy as an asset owned by the
 * requesting user and returns the resulting `fileId` so the composer can attach
 * it exactly like a picked file.
 *
 * This is the server side of Compose Share Phase 2's `mediaUrl=` support. Local
 * (native share-sheet) files never reach here — they are uploaded directly from
 * the client via the Oxy SDK.
 */

const router = Router();

const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';

/** Rate-limit window for the intent-media fetch. */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
/** Max intent-media fetches per user per window. Each one hits a remote origin. */
const RATE_LIMIT_MAX = 20;

/** Max accepted length of the input URL (matches the SSRF guard's own cap). */
const MAX_URL_LENGTH = 2048;

/**
 * Hard cap on the fetched media body. Unlike the streaming media proxy this
 * endpoint buffers the whole body in memory to hand it to the Oxy upload, so the
 * cap is deliberately tighter than the proxy's 256 MiB stream ceiling.
 */
const MAX_MEDIA_BYTES = 40 * 1024 * 1024; // 40 MiB

/** Absolute wall-clock ceiling for the fetch + upload round trip. */
const REQUEST_DEADLINE_MS = 25_000;

/** Idle socket timeout while reading the upstream body. */
const UPSTREAM_SOCKET_TIMEOUT_MS = 20_000;

/** Content-type families the composer accepts (audio is not a composer media type). */
const ALLOWED_MEDIA_PREFIXES = ['image/', 'video/'] as const;

const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  BAD_GATEWAY: 502,
} as const;

/** Marker error for an over-cap body (maps to 413 at the route layer). */
class PayloadTooLargeError extends Error {
  constructor() {
    super('media body exceeds cap');
    this.name = 'PayloadTooLargeError';
  }
}

const intentMediaStore = new RedisStore({
  prefix: 'rl:intent-media:',
  windowMs: RATE_LIMIT_WINDOW_MS,
});

const intentMediaRateLimiter = rateLimit({
  store: intentMediaStore,
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  // Authenticated route — key by the resolved user id, falling back to the
  // (IPv6-normalized) client address when the id is somehow absent.
  keyGenerator: (req: AuthRequest) =>
    req.user?.id || ipKeyGenerator(req.ip || req.socket.remoteAddress || 'unknown'),
  message: { error: 'Too many media fetch requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** True when a parameter-stripped content-type family is an accepted composer media type. */
function isComposerMediaType(family: string): boolean {
  if (MEDIA_REJECTED_TYPES.has(family)) return false;
  return ALLOWED_MEDIA_PREFIXES.some((prefix) => family.startsWith(prefix));
}

/**
 * Read the full upstream body into a single Buffer, aborting (413) once the cap
 * is exceeded. Rejects on socket idle timeout or stream error. The response
 * socket is always destroyed once we settle so it never leaks.
 */
function readFullBodyBounded(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (buf: Buffer): void => {
      if (settled) return;
      settled = true;
      resolve(buf);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (!response.destroyed) response.destroy();
      reject(error);
    };

    response.setTimeout(UPSTREAM_SOCKET_TIMEOUT_MS, () => {
      fail(new Error('upstream socket idle timeout'));
    });

    response.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => finish(Buffer.concat(chunks, total)));
    response.on('error', (error: Error) => fail(error));
  });
}

/** Derive a filename (with extension when present) from the final upstream URL. */
function deriveFileName(finalUrl: string): string {
  try {
    const last = new URL(finalUrl).pathname.split('/').filter(Boolean).pop();
    if (last && last.length > 0) return decodeURIComponent(last).slice(0, 200);
  } catch {
    // Fall through to the default below.
  }
  return 'shared-media';
}

router.post('/', intentMediaRateLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  const token = req.accessToken || req.headers.authorization?.replace('Bearer ', '');
  if (!userId || !token) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (rawUrl.length === 0) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Missing required "url" field' });
    return;
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'URL is too long' });
    return;
  }

  const abortController = new AbortController();
  const deadline = setTimeout(() => abortController.abort(), REQUEST_DEADLINE_MS);

  try {
    let upstream: UpstreamResult;
    try {
      upstream = await fetchUpstreamFollowingRedirects(rawUrl, {}, abortController.signal);
    } catch (error) {
      if (error instanceof SsrfRejection) {
        logger.warn('[IntentMedia] Rejected target', { reason: error.message });
        res.status(HTTP_STATUS.FORBIDDEN).json({ error: 'URL not permitted' });
        return;
      }
      logger.warn('[IntentMedia] Upstream fetch failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Could not fetch the media URL' });
      return;
    }

    const { response, finalUrl } = upstream;
    const status = response.statusCode ?? HTTP_STATUS.BAD_GATEWAY;
    if (status !== HTTP_STATUS.OK) {
      response.resume();
      logger.debug('[IntentMedia] Upstream returned non-OK status', { status });
      res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Could not fetch the media URL' });
      return;
    }

    const family = contentTypeFamily(response.headers);
    if (!isComposerMediaType(family)) {
      response.destroy();
      logger.warn('[IntentMedia] Rejected non-media content type', { contentType: family || 'unknown' });
      res.status(HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE).json({ error: 'URL is not a supported image or video' });
      return;
    }

    const declaredLength = Number(response.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES) {
      response.destroy();
      logger.warn('[IntentMedia] Declared body exceeds cap', { declaredLength });
      res.status(HTTP_STATUS.PAYLOAD_TOO_LARGE).json({ error: 'Media is too large' });
      return;
    }

    let buffer: Buffer;
    try {
      buffer = await readFullBodyBounded(response, MAX_MEDIA_BYTES);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        logger.warn('[IntentMedia] Streamed body exceeds cap');
        res.status(HTTP_STATUS.PAYLOAD_TOO_LARGE).json({ error: 'Media is too large' });
        return;
      }
      logger.warn('[IntentMedia] Failed to read upstream body', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Could not fetch the media URL' });
      return;
    }

    if (buffer.length === 0) {
      res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Could not fetch the media URL' });
      return;
    }

    const contentType = family;
    const fileName = deriveFileName(finalUrl);
    // Bun/Node global File (typed by @types/node) — provides a name + MIME type
    // so the multipart upload carries a sensible filename. `assetUpload` appends
    // this straight into its FormData and sends it to Oxy's asset service.
    // Copy into a fresh ArrayBuffer-backed view: a Node Buffer's backing store is
    // typed `ArrayBufferLike` (possibly SharedArrayBuffer), which is not a valid
    // `BlobPart`.
    const file = new File([new Uint8Array(buffer)], fileName, { type: contentType });

    // Upload as the requesting user (owner-scoped), never the service client, so
    // the asset is attributable to them exactly like a picked file. A scoped
    // client avoids mutating the shared service singleton under concurrency.
    const oxyClient = new OxyServices({ baseURL: OXY_API_URL });
    oxyClient.setTokens(token);

    let uploadResult: { file?: { id?: unknown } } | undefined;
    try {
      uploadResult = await oxyClient.assetUpload(file);
    } catch (error) {
      logger.error('[IntentMedia] Oxy asset upload failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Could not save the media' });
      return;
    }

    const fileId = uploadResult?.file?.id;
    if (typeof fileId !== 'string' || fileId.length === 0) {
      logger.error('[IntentMedia] Upload response missing file id');
      res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Could not save the media' });
      return;
    }

    const responseBody: Record<string, unknown> = { fileId, contentType };
    try {
      const assets = await getServiceOxyClient().getServiceAssetMetadataByIds([fileId]);
      const asset = assets[0];
      if (asset) {
        if (asset.width !== undefined) responseBody.width = asset.width;
        if (asset.height !== undefined) responseBody.height = asset.height;
        if (asset.durationSec !== undefined) responseBody.durationSec = asset.durationSec;
        if (asset.orientation !== undefined) responseBody.orientation = asset.orientation;
        if (asset.aspectRatio !== undefined) responseBody.aspectRatio = asset.aspectRatio;
        if (asset.size !== undefined) responseBody.sizeBytes = asset.size;
      }
    } catch (error) {
      logger.debug('[IntentMedia] Metadata lookup after upload failed (variant may still be pending)', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }

    res.status(HTTP_STATUS.OK).json(responseBody);
  } finally {
    clearTimeout(deadline);
  }
});

export default router;
