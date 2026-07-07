import type { MediaItem } from '@mention/shared-types';
import { logger } from '../../utils/logger';
import { recordAccessAndMaybeEnqueue } from '../../services/mediaCache/cacheStore';
import { persistRemoteMediaForFederatedOwnerDetailed } from '../../services/mediaCache/cacheWorker';
import { mediaMetadataService } from '../../services/MediaMetadataService';
import { isAbsoluteHttpUrl, getRemoteHost } from './url';
import type { ApMediaType } from '../activitypub/apMedia';

/**
 * Protocol-agnostic materialization of remote post media into Oxy S3.
 *
 * Extracted verbatim from the monolithic federation helpers. This is shared
 * across network connectors (ActivityPub today, atproto next) because mirroring
 * remote media to our own CDN keys off the remote URL + owner Oxy user id — it
 * has nothing protocol-specific in it. It depends only on the generic URL
 * predicates (`./url`) and the media-cache layer, never on any ActivityPub
 * runtime module, so a connector can reuse it without pulling in AP code.
 *
 * `ApMediaType` ('image' | 'video') is imported as a TYPE only (erased at
 * runtime), so this file carries no ActivityPub runtime dependency.
 */

export type ExtractedMediaAttachment = { type: 'media'; id: string; mediaType: ApMediaType };

/**
 * Persist remote media to Oxy S3 (when an owner is known), rewriting media ids
 * to the cached Oxy file ids. Permanently-unavailable remote media is dropped
 * from both the media list and matching attachments; soft failures keep the
 * original remote URL and queue it for a later cache attempt.
 */
export async function materializeFederatedMedia(
  media: MediaItem[],
  attachments: ExtractedMediaAttachment[],
  ownerOxyUserId: string | null | undefined,
  context: { activityId?: string; actorUri?: string } = {},
): Promise<{ media: MediaItem[]; attachments: ExtractedMediaAttachment[] }> {
  if (media.length === 0) return { media, attachments };

  const idMap = new Map<string, string>();
  const removedRemoteUrls = new Set<string>();
  const outputMedia: MediaItem[] = [];

  for (const item of media) {
    const remoteUrl = item.id;
    if (!isAbsoluteHttpUrl(remoteUrl)) {
      outputMedia.push(item);
      continue;
    }

    if (!ownerOxyUserId) {
      void recordAccessAndMaybeEnqueue(remoteUrl);
      outputMedia.push(item);
      continue;
    }

    const persistedResult = await persistRemoteMediaForFederatedOwnerDetailed(remoteUrl, ownerOxyUserId, {
      remoteHost: getRemoteHost(remoteUrl),
      activityId: context.activityId,
      actorUri: context.actorUri,
      mediaType: item.type === 'video' ? 'video' : 'image',
    });

    if (!persistedResult.ok) {
      if (persistedResult.permanent) {
        logger.info('[Federation] Dropping permanently unavailable remote media', {
          remoteHost: getRemoteHost(remoteUrl),
          status: persistedResult.status,
          activityId: context.activityId,
        });
        removedRemoteUrls.add(remoteUrl);
        continue;
      }
      void recordAccessAndMaybeEnqueue(remoteUrl);
      outputMedia.push(item);
      continue;
    }

    const persisted = persistedResult.media;
    idMap.set(remoteUrl, persisted.oxyFileId);
    outputMedia.push({
      ...item,
      id: persisted.oxyFileId,
      remoteUrl,
      cachedFromFederation: true,
    });
  }

  if (idMap.size === 0 && removedRemoteUrls.size === 0) {
    return { media: outputMedia, attachments };
  }

  const outputAttachments = attachments
    .filter((attachment) => !removedRemoteUrls.has(attachment.id))
    .map((attachment) => ({
      ...attachment,
      id: idMap.get(attachment.id) || attachment.id,
    }));

  const enrichedMedia = await mediaMetadataService.enrichFromOxy(outputMedia);
  return { media: enrichedMedia, attachments: outputAttachments };
}
