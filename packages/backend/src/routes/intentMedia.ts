import { Router, Response } from 'express';
import { IncomingMessage } from 'node:http';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { OxyServices } from '@oxyhq/core';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';

import { logger } from '../utils/logger';
import { RedisStore } from '../middleware/rateLimitStore';
import { getServiceOxyClient, uploadServiceUserMedia } from '../utils/oxyHelpers';
import type { OxyAuthRequestWithMcp } from '../mcp/middleware/mcpAuth';
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
 * Authenticated. Accepts either:
 *  - `{ url }` — SSRF-safe remote fetch (compose intent / MCP)
 *  - `{ base64, mimeType, filename? }` — inline bytes (MCP / Claude)
 *
 * Uploads to Oxy as an asset owned by the requesting user and returns `fileId`.
 * Oxy-session callers use `assetUpload` with the user bearer; MCP JWT callers
 * use the service-token `POST /assets/service/user-media` path.
 */

const router = Router();

const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
const MAX_URL_LENGTH = 2048;
const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil((MAX_MEDIA_BYTES * 4) / 3) + 256;
const REQUEST_DEADLINE_MS = 25_000;
const UPSTREAM_SOCKET_TIMEOUT_MS = 20_000;
const ALLOWED_MEDIA_PREFIXES = ['image/', 'video/'] as const;

const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  BAD_GATEWAY: 502,
} as const;

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
  keyGenerator: (req: AuthRequest) =>
    req.user?.id || ipKeyGenerator(req.ip || req.socket.remoteAddress || 'unknown'),
  message: { error: 'Too many media fetch requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function isComposerMediaType(family: string): boolean {
  if (MEDIA_REJECTED_TYPES.has(family)) return false;
  return ALLOWED_MEDIA_PREFIXES.some((prefix) => family.startsWith(prefix));
}

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

function deriveFileName(finalUrl: string): string {
  try {
    const last = new URL(finalUrl).pathname.split('/').filter(Boolean).pop();
    if (last && last.length > 0) return decodeURIComponent(last).slice(0, 200);
  } catch {
    // fall through
  }
  return 'shared-media';
}

function extensionForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'video/mp4') return 'mp4';
  if (mime.startsWith('video/')) return 'mp4';
  if (mime.startsWith('image/')) return 'img';
  return 'bin';
}

function decodeBase64Payload(raw: string): Buffer {
  const trimmed = raw.trim();
  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/i.exec(trimmed);
  const payload = dataUrlMatch ? dataUrlMatch[2] : trimmed;
  if (payload.length === 0 || payload.length > MAX_BASE64_LENGTH) {
    throw new PayloadTooLargeError();
  }
  return Buffer.from(payload, 'base64');
}

async function fetchRemoteMediaBuffer(rawUrl: string, abortSignal: AbortSignal): Promise<{
  buffer: Buffer;
  contentType: string;
  fileName: string;
}> {
  let upstream: UpstreamResult;
  try {
    upstream = await fetchUpstreamFollowingRedirects(rawUrl, {}, abortSignal);
  } catch (error) {
    if (error instanceof SsrfRejection) {
      throw Object.assign(new Error('URL not permitted'), { status: HTTP_STATUS.FORBIDDEN });
    }
    throw Object.assign(new Error('Could not fetch the media URL'), { status: HTTP_STATUS.BAD_GATEWAY });
  }

  const { response, finalUrl } = upstream;
  const status = response.statusCode ?? HTTP_STATUS.BAD_GATEWAY;
  if (status !== HTTP_STATUS.OK) {
    response.resume();
    throw Object.assign(new Error('Could not fetch the media URL'), { status: HTTP_STATUS.BAD_GATEWAY });
  }

  const family = contentTypeFamily(response.headers);
  if (!isComposerMediaType(family)) {
    response.destroy();
    throw Object.assign(new Error('URL is not a supported image or video'), { status: HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE });
  }

  const declaredLength = Number(response.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES) {
    response.destroy();
    throw Object.assign(new Error('Media is too large'), { status: HTTP_STATUS.PAYLOAD_TOO_LARGE });
  }

  let buffer: Buffer;
  try {
    buffer = await readFullBodyBounded(response, MAX_MEDIA_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      throw Object.assign(new Error('Media is too large'), { status: HTTP_STATUS.PAYLOAD_TOO_LARGE });
    }
    throw Object.assign(new Error('Could not fetch the media URL'), { status: HTTP_STATUS.BAD_GATEWAY });
  }

  if (buffer.length === 0) {
    throw Object.assign(new Error('Could not fetch the media URL'), { status: HTTP_STATUS.BAD_GATEWAY });
  }

  return {
    buffer,
    contentType: family,
    fileName: deriveFileName(finalUrl),
  };
}

async function uploadWithOxySession(
  token: string,
  buffer: Buffer,
  contentType: string,
  fileName: string,
): Promise<string> {
  const file = new File([new Uint8Array(buffer)], fileName, { type: contentType });
  const oxyClient = new OxyServices({ baseURL: OXY_API_URL });
  oxyClient.setTokens(token);
  const uploadResult = await oxyClient.assetUpload(file);
  const fileId = uploadResult?.file?.id;
  if (typeof fileId !== 'string' || fileId.length === 0) {
    throw new Error('Could not save the media');
  }
  return fileId;
}

async function enrichUploadResponse(fileId: string, contentType: string): Promise<Record<string, unknown>> {
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
    logger.debug('[IntentMedia] Metadata lookup after upload failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
  return responseBody;
}

router.post('/', intentMediaRateLimiter, async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const rawBase64 = typeof req.body?.base64 === 'string' ? req.body.base64 : '';
  const hasUrl = rawUrl.length > 0;
  const hasBase64 = rawBase64.length > 0;

  if (hasUrl === hasBase64) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: hasUrl && hasBase64
        ? 'Provide either "url" or "base64", not both'
        : 'Missing required "url" or "base64" field',
    });
    return;
  }

  if (hasUrl && rawUrl.length > MAX_URL_LENGTH) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'URL is too long' });
    return;
  }

  const abortController = new AbortController();
  const deadline = setTimeout(() => abortController.abort(), REQUEST_DEADLINE_MS);

  try {
    let buffer: Buffer;
    let contentType: string;
    let fileName: string;

    if (hasUrl) {
      try {
        const fetched = await fetchRemoteMediaBuffer(rawUrl, abortController.signal);
        buffer = fetched.buffer;
        contentType = fetched.contentType;
        fileName = fetched.fileName;
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'status' in error
          ? Number((error as { status: number }).status)
          : HTTP_STATUS.BAD_GATEWAY;
        const message = error instanceof Error ? error.message : 'Could not fetch the media URL';
        if (status === HTTP_STATUS.FORBIDDEN) {
          logger.warn('[IntentMedia] Rejected target', { reason: message });
        }
        res.status(status).json({ error: message });
        return;
      }
    } else {
      const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType.trim().toLowerCase() : '';
      if (!mimeType || !isComposerMediaType(mimeType)) {
        res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Valid "mimeType" (image/* or video/*) is required with base64' });
        return;
      }
      try {
        buffer = decodeBase64Payload(rawBase64);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          res.status(HTTP_STATUS.PAYLOAD_TOO_LARGE).json({ error: 'Media is too large' });
          return;
        }
        res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'Invalid base64 payload' });
        return;
      }
      if (buffer.length === 0 || buffer.length > MAX_MEDIA_BYTES) {
        res.status(HTTP_STATUS.PAYLOAD_TOO_LARGE).json({ error: 'Media is too large' });
        return;
      }
      contentType = mimeType;
      const requestedName = typeof req.body?.filename === 'string' ? req.body.filename.trim() : '';
      fileName = requestedName.length > 0
        ? requestedName.slice(0, 200)
        : `upload.${extensionForMime(mimeType)}`;
    }

    const mcpContext = (req as OxyAuthRequestWithMcp).mcp;
    const oxySessionToken = req.accessToken;
    let fileId: string;

    try {
      if (mcpContext) {
        const uploaded = await uploadServiceUserMedia({
          ownerUserId: userId,
          buffer,
          contentType,
          fileName,
        });
        fileId = uploaded.fileId;
      } else {
        const token = oxySessionToken || req.headers.authorization?.replace(/^Bearer\s+/i, '');
        if (!token) {
          res.status(HTTP_STATUS.UNAUTHORIZED).json({ error: 'Unauthorized' });
          return;
        }
        fileId = await uploadWithOxySession(token, buffer, contentType, fileName);
      }
    } catch (error) {
      logger.error('[IntentMedia] Upload failed', {
        reason: error instanceof Error ? error.message : 'unknown',
        mcp: Boolean(mcpContext),
      });
      res.status(HTTP_STATUS.BAD_GATEWAY).json({ error: 'Could not save the media' });
      return;
    }

    const responseBody = await enrichUploadResponse(fileId, contentType);
    res.status(HTTP_STATUS.OK).json(responseBody);
  } finally {
    clearTimeout(deadline);
  }
});

export default router;
