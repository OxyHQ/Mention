import mongoose from 'mongoose';
import type { MediaItem } from '@mention/shared-types';
import type { ServiceAssetMetadata } from '@oxyhq/core';
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

/** Copy persisted intrinsic fields from a raw Mongo/hydration object. */
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
  if (typeof raw.alt === 'string' && raw.alt.trim().length > 0) out.alt = raw.alt.trim();
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
  if (patch.alt !== undefined && patch.alt.trim().length > 0) merged.alt = patch.alt.trim();
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

  if (typeof attachment.name === 'string' && attachment.name.trim().length > 0) {
    patch.alt = attachment.name.trim();
  }

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
