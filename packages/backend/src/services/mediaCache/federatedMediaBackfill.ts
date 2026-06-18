import type { MediaItem, PostAttachmentDescriptor } from '@mention/shared-types';
import type { Types } from 'mongoose';

import { Post } from '../../models/Post';
import { logger } from '../../utils/logger';
import { recordAccessAndMaybeEnqueue } from './cacheStore';
import { persistRemoteMediaForFederatedOwner, type PersistedFederatedMedia } from './cacheWorker';
import {
  FEDERATED_MEDIA_BACKFILL_BATCH_SIZE,
  FEDERATED_MEDIA_BACKFILL_CONCURRENCY,
} from './constants';
import { isMediaCacheEnabled } from './oxyMediaStore';

export const REMOTE_MEDIA_ID_PATTERN = /^https?:\/\//i;

export const FEDERATED_MEDIA_BACKFILL_MATCH = {
  federation: { $ne: null },
  oxyUserId: { $type: 'string', $ne: '' },
  'content.media': { $elemMatch: { id: REMOTE_MEDIA_ID_PATTERN } },
} as const;

type StoredMediaItem = MediaItem & {
  remoteUrl?: string;
  cachedFromFederation?: boolean;
  posterFileId?: string;
};

export interface FederatedMediaBackfillPost {
  _id: Types.ObjectId;
  oxyUserId?: string | null;
  federation?: { activityId?: string } | null;
  content?: {
    media?: StoredMediaItem[];
    attachments?: PostAttachmentDescriptor[];
  };
}

interface PostBackfillResult {
  updatedPosts: number;
  convertedMedia: number;
  failedMedia: number;
}

export interface FederatedMediaBackfillResult {
  scannedPosts: number;
  updatedPosts: number;
  convertedMedia: number;
  failedMedia: number;
  disabled: boolean;
}

function isAbsoluteHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && REMOTE_MEDIA_ID_PATTERN.test(value);
}

function getRemoteHost(remoteUrl: string): string | undefined {
  try {
    return new URL(remoteUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function buildPersistedMediaItem(
  item: StoredMediaItem,
  remoteUrl: string,
  persisted: PersistedFederatedMedia,
): StoredMediaItem {
  return {
    ...item,
    id: persisted.oxyFileId,
    remoteUrl,
    cachedFromFederation: true,
    ...(persisted.posterFileId ? { posterFileId: persisted.posterFileId } : {}),
  };
}

function rewriteMediaAttachments(
  attachments: PostAttachmentDescriptor[] | undefined,
  idMap: Map<string, string>,
): PostAttachmentDescriptor[] | undefined {
  if (!attachments || idMap.size === 0) return attachments;

  return attachments.map((attachment) => {
    if (attachment.type !== 'media' || !attachment.id) return attachment;
    const mapped = idMap.get(attachment.id);
    return mapped ? { ...attachment, id: mapped } : attachment;
  });
}

export async function backfillFederatedMediaPost(
  post: FederatedMediaBackfillPost,
): Promise<PostBackfillResult> {
  const ownerUserId = post.oxyUserId;
  const media = Array.isArray(post.content?.media) ? post.content.media : [];
  if (!ownerUserId || media.length === 0) {
    return { updatedPosts: 0, convertedMedia: 0, failedMedia: 0 };
  }

  const persistedByRemoteUrl = new Map<string, PersistedFederatedMedia | null>();
  const idMap = new Map<string, string>();
  const changedRemoteUrls: string[] = [];
  const nextMedia: StoredMediaItem[] = [];
  let failedMedia = 0;

  for (const item of media) {
    const remoteUrl = item.id;
    if (!isAbsoluteHttpUrl(remoteUrl)) {
      nextMedia.push(item);
      continue;
    }

    if (!persistedByRemoteUrl.has(remoteUrl)) {
      const persisted = await persistRemoteMediaForFederatedOwner(remoteUrl, ownerUserId, {
        remoteHost: getRemoteHost(remoteUrl),
        activityId: post.federation?.activityId,
        postId: String(post._id),
        mediaType: item.type,
        backfill: true,
      });
      persistedByRemoteUrl.set(remoteUrl, persisted);

      if (!persisted) {
        failedMedia += 1;
        void recordAccessAndMaybeEnqueue(remoteUrl).catch((error: unknown) => {
          logger.warn('[MediaBackfill] Failed to enqueue proxy cache fallback', {
            reason: error instanceof Error ? error.message : 'unknown',
          });
        });
      }
    }

    const persisted = persistedByRemoteUrl.get(remoteUrl);
    if (!persisted) {
      nextMedia.push(item);
      continue;
    }

    idMap.set(remoteUrl, persisted.oxyFileId);
    changedRemoteUrls.push(remoteUrl);
    nextMedia.push(buildPersistedMediaItem(item, remoteUrl, persisted));
  }

  if (idMap.size === 0 || changedRemoteUrls.length === 0) {
    return { updatedPosts: 0, convertedMedia: 0, failedMedia };
  }

  const update: Record<string, unknown> = {
    'content.media': nextMedia,
  };
  const nextAttachments = rewriteMediaAttachments(post.content?.attachments, idMap);
  if (Array.isArray(nextAttachments)) {
    update['content.attachments'] = nextAttachments;
  }

  const result = await Post.updateOne(
    {
      _id: post._id,
      'content.media.id': { $in: changedRemoteUrls },
    },
    { $set: update },
  );

  const modifiedCount = typeof result.modifiedCount === 'number' ? result.modifiedCount : 0;
  return {
    updatedPosts: modifiedCount > 0 ? 1 : 0,
    convertedMedia: modifiedCount > 0 ? idMap.size : 0,
    failedMedia,
  };
}

/**
 * Convert historical federated post media from remote HTTP URLs to durable Oxy
 * assets owned by the corresponding federated Oxy user. New imports already do
 * this inline; this job makes pre-existing rows match that storage model.
 */
export async function runFederatedMediaBackfillOnce(): Promise<FederatedMediaBackfillResult> {
  if (!isMediaCacheEnabled()) {
    logger.debug('[MediaBackfill] skipped — media writes disabled');
    return { scannedPosts: 0, updatedPosts: 0, convertedMedia: 0, failedMedia: 0, disabled: true };
  }

  const posts = await Post.find(FEDERATED_MEDIA_BACKFILL_MATCH)
    .select('_id oxyUserId federation.activityId content.media content.attachments createdAt')
    .sort({ createdAt: -1 })
    .limit(FEDERATED_MEDIA_BACKFILL_BATCH_SIZE)
    .lean<FederatedMediaBackfillPost[]>();

  if (posts.length === 0) {
    return { scannedPosts: 0, updatedPosts: 0, convertedMedia: 0, failedMedia: 0, disabled: false };
  }

  logger.info(`[MediaBackfill] Converting remote media for ${posts.length} historical federated posts`);

  const totals: FederatedMediaBackfillResult = {
    scannedPosts: posts.length,
    updatedPosts: 0,
    convertedMedia: 0,
    failedMedia: 0,
    disabled: false,
  };

  for (let i = 0; i < posts.length; i += FEDERATED_MEDIA_BACKFILL_CONCURRENCY) {
    const batch = posts.slice(i, i + FEDERATED_MEDIA_BACKFILL_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((post) => backfillFederatedMediaPost(post)));

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        totals.updatedPosts += outcome.value.updatedPosts;
        totals.convertedMedia += outcome.value.convertedMedia;
        totals.failedMedia += outcome.value.failedMedia;
      } else {
        totals.failedMedia += 1;
        logger.warn('[MediaBackfill] Post media conversion failed', {
          reason: outcome.reason instanceof Error ? outcome.reason.message : 'unknown',
        });
      }
    }
  }

  logger.info('[MediaBackfill] Run complete', {
    scannedPosts: totals.scannedPosts,
    updatedPosts: totals.updatedPosts,
    convertedMedia: totals.convertedMedia,
    failedMedia: totals.failedMedia,
  });

  return totals;
}
