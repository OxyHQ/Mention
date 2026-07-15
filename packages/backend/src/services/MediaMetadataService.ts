import mongoose from 'mongoose';
import type { MediaItem } from '@mention/shared-types';
import { normalizeInlineText, type ServiceAssetMetadata } from '@oxyhq/core';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';
import type { ApAttachment } from '../connectors/activitypub/apMedia';

const OXY_ID_RE = /^[a-f0-9]{24}$/i;

export function isOxyFileId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id) && OXY_ID_RE.test(id);
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.trunc(value);
  return n > 0 ? n : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value > 0 ? value : undefined;
}

/**
 * THE alt-text rule. Every path that can put an `alt` on a media item runs a
 * value through this and nothing else: the native write boundary
 * (`utils/mediaInput.ts`, which caps the length on top), the ActivityPub ingest
 * ({@link patchFromApAttachment}), the atproto ingest (`connectors/atproto/post.mapper.ts`)
 * and the one-shot backfill that cleans legacy rows.
 *
 * Alt text is a ONE-LINE label carrying whatever whitespace its author's client
 * (ours or a remote one) happened to send. Clients render text faithfully (React
 * Native Web maps `Text` to `white-space: pre-wrap`), so an embedded newline or a
 * run of spaces would be visible, hence the canonical inline normalizer rather
 * than a bare `.trim()`.
 *
 * It has to hold at the WRITE boundary, not just on the way out: a native post's
 * media is signed onto the author's MTN hash chain (`mentionRecordBuilders`), and
 * a signed record is immutable — an un-normalized alt persisted there can never
 * be repaired, by this or any other backfill.
 *
 * Returns undefined for a missing / non-string / whitespace-only value so the
 * caller omits the field instead of storing a blank one.
 */
export function normalizeAlt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const alt = normalizeInlineText(value);
  return alt.length > 0 ? alt : undefined;
}

/**
 * Copy persisted intrinsic fields from a raw Mongo/hydration object.
 *
 * The {@link normalizeAlt} call below is a READ BACKSTOP for legacy rows written
 * before the write boundary enforced the rule — NOT where the invariant lives.
 * Everything stored from now on is already normalized (see {@link normalizeAlt}).
 */
export function readPersistedMediaFields(raw: Record<string, unknown>): Partial<MediaItem> {
  const out: Partial<MediaItem> = {};
  const width = positiveInt(raw.width);
  const height = positiveInt(raw.height);
  const durationSec = positiveNumber(raw.durationSec);
  const aspectRatio = positiveNumber(raw.aspectRatio);
  const sizeBytes = positiveInt(raw.sizeBytes);

  if (width) out.width = width;
  if (height) out.height = height;
  if (durationSec !== undefined) out.durationSec = durationSec;
  if (aspectRatio !== undefined) out.aspectRatio = aspectRatio;
  if (sizeBytes) out.sizeBytes = sizeBytes;

  if (raw.orientation === 'portrait' || raw.orientation === 'landscape' || raw.orientation === 'square') {
    out.orientation = raw.orientation;
  }
  const alt = normalizeAlt(raw.alt);
  if (alt) out.alt = alt;
  if (typeof raw.mime === 'string' && raw.mime.trim().length > 0) out.mime = raw.mime.trim();
  if (typeof raw.remoteUrl === 'string' && raw.remoteUrl.trim().length > 0) out.remoteUrl = raw.remoteUrl.trim();
  if (raw.cachedFromFederation === true) out.cachedFromFederation = true;

  return out;
}

export function mergeMediaItem(existing: MediaItem, patch: Partial<MediaItem>): MediaItem {
  const merged: MediaItem = { ...existing };
  if (patch.width !== undefined) merged.width = patch.width;
  if (patch.height !== undefined) merged.height = patch.height;
  if (patch.durationSec !== undefined) merged.durationSec = patch.durationSec;
  if (patch.orientation !== undefined) merged.orientation = patch.orientation;
  if (patch.aspectRatio !== undefined) merged.aspectRatio = patch.aspectRatio;
  if (patch.sizeBytes !== undefined) merged.sizeBytes = patch.sizeBytes;
  if (patch.mime !== undefined) merged.mime = patch.mime;
  if (patch.remoteUrl !== undefined) merged.remoteUrl = patch.remoteUrl;
  if (patch.cachedFromFederation !== undefined) merged.cachedFromFederation = patch.cachedFromFederation;
  const alt = normalizeAlt(patch.alt);
  if (alt) merged.alt = alt;
  return merged;
}

function copyFromOxyAsset(item: MediaItem, asset: ServiceAssetMetadata): MediaItem {
  const patch: Partial<MediaItem> = {};
  if (asset.width !== undefined) patch.width = asset.width;
  if (asset.height !== undefined) patch.height = asset.height;
  if (asset.durationSec !== undefined) patch.durationSec = asset.durationSec;
  if (asset.orientation !== undefined) patch.orientation = asset.orientation;
  if (asset.aspectRatio !== undefined) patch.aspectRatio = asset.aspectRatio;
  if (asset.size !== undefined) patch.sizeBytes = asset.size;
  return mergeMediaItem(item, patch);
}

/** AP Note attachment → intrinsic fields (pre-cache; Oxy wins on later enrich). */
export function patchFromApAttachment(attachment: ApAttachment): Partial<MediaItem> {
  const patch: Partial<MediaItem> = {};
  const width = positiveInt(attachment.width);
  const height = positiveInt(attachment.height);
  if (width) patch.width = width;
  if (height) patch.height = height;

  const durationRaw = attachment.duration;
  if (typeof durationRaw === 'number' && Number.isFinite(durationRaw) && durationRaw > 0) {
    patch.durationSec = durationRaw;
  } else if (typeof durationRaw === 'string') {
    const parsed = parseFloat(durationRaw);
    if (Number.isFinite(parsed) && parsed > 0) patch.durationSec = parsed;
  }

  // AP `attachment.name` is the alt text of a federated attachment.
  const alt = normalizeAlt(attachment.name);
  if (alt) patch.alt = alt;

  if (patch.width && patch.height && patch.orientation === undefined) {
    const ratio = patch.height / patch.width;
    if (ratio >= 1.1) patch.orientation = 'portrait';
    else if (ratio <= 0.9) patch.orientation = 'landscape';
    else patch.orientation = 'square';
    patch.aspectRatio = patch.width / patch.height;
  }

  return patch;
}

export class MediaMetadataService {
  /** Batch-resolve Oxy file ids and copy intrinsic metadata onto media items. */
  async enrichFromOxy(items: MediaItem[]): Promise<MediaItem[]> {
    if (!Array.isArray(items) || items.length === 0) return items;

    const oxyIds = [...new Set(items.map((item) => item.id).filter(isOxyFileId))];
    if (oxyIds.length === 0) return items;

    let resolved: ServiceAssetMetadata[] = [];
    try {
      resolved = await getServiceOxyClient().getServiceAssetMetadataByIds(oxyIds);
    } catch (error) {
      logger.warn('MediaMetadataService.enrichFromOxy failed', {
        error: error instanceof Error ? error.message : String(error),
        count: oxyIds.length,
      });
      return items;
    }

    const byId = new Map(resolved.map((entry) => [entry.id, entry]));
    return items.map((item) => {
      if (!isOxyFileId(item.id)) return item;
      const asset = byId.get(item.id);
      if (!asset) return item;
      return copyFromOxyAsset(item, asset);
    });
  }

  /** True when any Oxy-backed item is still missing width/height after enrich. */
  needsOxyRetry(items: MediaItem[]): boolean {
    return items.some(
      (item) =>
        isOxyFileId(item.id)
        && item.type === 'video'
        && (item.width === undefined || item.height === undefined || item.durationSec === undefined),
    );
  }
}

export const mediaMetadataService = new MediaMetadataService();
