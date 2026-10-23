import { Router, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { OxyServices } from '@oxy.so/core';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';

import { logger } from '../utils/logger';
import { RedisStore } from '../middleware/rateLimitStore';
import { hashedIpKey } from '../utils/ipKey';
import { getServiceOxyClient, uploadServiceUserMedia, requesterFiles } from '../utils/oxyHelpers';
import type { OxyAuthRequestWithMcp } from '../mcp/middleware/mcpAuth';
import type { RequestSafetyContext } from '../utils/safetyRequester';
import { config } from '../config';
import { contentTypeFamilyFromString } from '../utils/safeUpstreamFetch';
import { describeOxyError, oxyErrorStatus } from '../services/oxyFiles/oxyErrors';
import { MEDIA_REJECTED_TYPES } from '../services/mediaCache/mediaTypes';

/**
 * POST /posts/intent-media
 *
 * Authenticated. Accepts either:
 *  - `{ url }` — imported BY OXY into the requesting user's files
 *    (`importUserMedia`, ADR 0043 D7: Oxy's own SSRF-safe fetcher; the bytes
 *    never pass through Mention) — compose intent / MCP
 *  - `{ base64, mimeType, filename? }` — inline bytes (MCP / Claude)
 *
 * Stores an asset owned by the requesting user and returns `fileId`. Inline
 * bytes from an Oxy-session caller use `assetUpload` with the user bearer; from
 * an MCP JWT caller, the service-token `POST /assets/service/user-media` path.
 */

const router = Router();

const OXY_API_URL = config.oxyApiUrl;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
const MAX_URL_LENGTH = 2048;
const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil((MAX_MEDIA_BYTES * 4) / 3) + 256;
const IMPORT_DEADLINE_MS = 75_000;
const ALLOWED_MEDIA_PREFIXES = ['image/', 'video/'] as const;

const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE: 422,
  UNAVAILABLE_FOR_LEGAL_REASONS: 451,
  BAD_GATEWAY: 502,
  GATEWAY_TIMEOUT: 504,
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
  keyGenerator: (req: AuthRequest) => req.user?.id || hashedIpKey(req),
  message: { error: 'Too many media fetch requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function isComposerMediaType(family: string): boolean {
  if (MEDIA_REJECTED_TYPES.has(family)) return false;
  return ALLOWED_MEDIA_PREFIXES.some((prefix) => family.startsWith(prefix));
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

function safeUploadBasename(name: string): string {
  const normalized = name.replace(/\\/g, '/');
  const base = normalized.split('/').filter(Boolean).pop() ?? normalized;
  return base.slice(0, 200);
}

function decodeBase64Payload(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BASE64_LENGTH) {
    throw new PayloadTooLargeError();
  }
  const dataUrlMatch = /^data:([^;,]+);base64,(.+)$/i.exec(trimmed);
  const payload = dataUrlMatch ? dataUrlMatch[2] : trimmed;
  if (payload.length === 0 || payload.length > MAX_BASE64_LENGTH) {
    throw new PayloadTooLargeError();
  }
  return Buffer.from(payload, 'base64');
}

/** Oxy's refusal of a source, as this route answers it. */
function importRefusal(error: unknown): { status: number; message: string } {
  const status = oxyErrorStatus(error);
  switch (status) {
    case HTTP_STATUS.BAD_REQUEST:
      return { status: HTTP_STATUS.BAD_REQUEST, message: 'Invalid media URL' };
    case HTTP_STATUS.UNPROCESSABLE:
      // `SOURCE_URL_REFUSED`: not https, a private address, credentials in it.
      return { status: HTTP_STATUS.FORBIDDEN, message: 'URL not permitted' };
    case HTTP_STATUS.UNSUPPORTED_MEDIA_TYPE:
      return { status, message: 'URL is not a supported image or video' };
    case HTTP_STATUS.PAYLOAD_TOO_LARGE:
      return { status, message: 'Media is too large' };
    case HTTP_STATUS.UNAVAILABLE_FOR_LEGAL_REASONS:
      return { status, message: 'This media was removed after a legal claim' };
    case HTTP_STATUS.BAD_GATEWAY:
    case HTTP_STATUS.GATEWAY_TIMEOUT:
      return { status: HTTP_STATUS.BAD_GATEWAY, message: 'Could not fetch the media URL' };
    default:
      return { status: HTTP_STATUS.BAD_GATEWAY, message: 'Could not save the media' };
  }
}

/**
 * Import a remote image or video into the user's own Oxy files (ADR 0043 D7):
 * Oxy fetches it with its SSRF-safe fetcher (https on every hop, public
 * addresses only, bounded redirects, size and time), stores it public — post
 * media renders from the CDN, which 404s a private asset — and answers the
 * same file for the same URL again without fetching. One fetcher for every
 * Oxy product instead of a copy here, and the bytes never pass through
 * Mention. The route already verified the caller IS `ownerUserId`, which is
 * what the service import's authority rests on (the same as the MCP upload).
 */
async function importRemoteMedia(
  requester: RequestSafetyContext,
  ownerUserId: string,
  rawUrl: string,
  signal: AbortSignal,
): Promise<{ fileId: string; contentType: string }> {
  const imported = await requesterFiles(requester, 'upload-media-from-url').importUserMedia(
    ownerUserId,
    rawUrl,
    {
      visibility: 'public',
      signal,
    },
  );
  if (imported.file.status !== 'active') {
    throw Object.assign(new Error('The imported file is not active'), {
      status: HTTP_STATUS.BAD_GATEWAY,
    });
  }
  return { fileId: imported.file.id, contentType: imported.file.mime };
}

async function uploadWithOxySession(
  token: string,
  buffer: Buffer,
  contentType: string,
  fileName: string,
): Promise<string> {
  const file = new File([new Uint8Array(buffer)], fileName, { type: contentType });
  const oxyClient = new OxyServices({ baseURL: OXY_API_URL });
  oxyClient.session.setAccessToken(token);
  // Post media renders from the public CDN, which 404s a private asset — the
  // same visibility the MCP path's service upload already gives it.
  const uploadResult = await oxyClient.assets.upload(file, { visibility: 'public' });
  const fileId = uploadResult?.file?.id;
  if (typeof fileId !== 'string' || fileId.length === 0) {
    throw new Error('Could not save the media');
  }
  return fileId;
}

async function enrichUploadResponse(
  fileId: string,
  contentType: string,
): Promise<Record<string, unknown>> {
  const responseBody: Record<string, unknown> = { fileId, contentType };
  try {
    const assets = await getServiceOxyClient().assets.metadataByIds([fileId]);
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
      error:
        hasUrl && hasBase64
          ? 'Provide either "url" or "base64", not both'
          : 'Missing required "url" or "base64" field',
    });
    return;
  }

  if (hasUrl && rawUrl.length > MAX_URL_LENGTH) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'URL is too long' });
    return;
  }

  // Oxy's fetch is bounded at 60 s; give it that, plus the store.
  const importAbort = new AbortController();
  const deadline = setTimeout(() => importAbort.abort(), IMPORT_DEADLINE_MS);

  try {
    let buffer: Buffer;
    let contentType: string;
    let fileName: string;

    if (hasUrl) {
      let imported: { fileId: string; contentType: string };
      try {
        imported = await importRemoteMedia(req, userId, rawUrl, importAbort.signal);
      } catch (error) {
        const refusal = importRefusal(error);
        if (refusal.status === HTTP_STATUS.FORBIDDEN) {
          logger.warn('[IntentMedia] Rejected target', { reason: describeOxyError(error) });
        } else if (refusal.status === HTTP_STATUS.BAD_GATEWAY) {
          logger.warn('[IntentMedia] Import failed', { reason: describeOxyError(error) });
        }
        res.status(refusal.status).json({ error: refusal.message });
        return;
      }
      res
        .status(HTTP_STATUS.OK)
        .json(await enrichUploadResponse(imported.fileId, imported.contentType));
      return;
    } else {
      if (rawBase64.length > MAX_BASE64_LENGTH) {
        res.status(HTTP_STATUS.PAYLOAD_TOO_LARGE).json({ error: 'Media is too large' });
        return;
      }
      const mimeType = contentTypeFamilyFromString(
        typeof req.body?.mimeType === 'string' ? req.body.mimeType : undefined,
      );
      if (!mimeType || !isComposerMediaType(mimeType)) {
        res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json({ error: 'Valid "mimeType" (image/* or video/*) is required with base64' });
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
      fileName =
        requestedName.length > 0
          ? safeUploadBasename(requestedName)
          : `upload.${extensionForMime(mimeType)}`;
    }

    const mcpContext = (req as OxyAuthRequestWithMcp).mcp;
    const oxySessionToken = req.accessToken;
    let fileId: string;

    try {
      if (mcpContext || (req as RequestSafetyContext).capability || req.serviceApp) {
        const uploaded = await uploadServiceUserMedia({
          requester: req,
          ownerUserId: userId,
          buffer,
          contentType,
          fileName,
        });
        fileId = uploaded.fileId;
      } else {
        const token = oxySessionToken;
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
