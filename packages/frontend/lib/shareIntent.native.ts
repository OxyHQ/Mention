/**
 * Native bridge for OS share-sheet → compose intent.
 *
 * When the user picks "Mention" from the OS share sheet (iOS/Android), the
 * `expo-share-intent` module surfaces the payload through `useShareIntent`.
 * We map text/URL into the same `?text=&url=` query string the web Share
 * Target API uses, then push `/compose` — so all entry points hit the same
 * parser (`utils/composeIntent.ts`).
 *
 * Shared FILES (image/video) are uploaded to Oxy here (local `file://` URIs the
 * backend intent-media fetch endpoint could never reach), then handed to the
 * composer via `pendingShareMedia` so a media-only share is NOT discarded.
 */

import { useEffect, useRef } from 'react';
import { useShareIntent } from 'expo-share-intent';
import type { ImperativeRouter } from 'expo-router';

import { logger } from '@/lib/logger';
import { oxyServices } from '@/lib/oxyServices';
import { setPendingShareMedia, type PendingShareMediaItem } from '@/utils/pendingShareMedia';

export interface UseShareIntentRouterArgs {
  router: ImperativeRouter;
  enabled?: boolean;
}

/** Max shared files uploaded + attached per share (mirrors the composer's media cap). */
const MAX_SHARE_FILES = 4;

export const useShareIntentRouter = ({
  router,
  enabled = true,
}: UseShareIntentRouterArgs): void => {
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntent({
    disabled: !enabled,
  });
  // Guards the async upload/navigate flow so a re-render mid-upload can't start
  // a second pass (which would double-upload and double-navigate).
  const processingRef = useRef(false);

  useEffect(() => {
    if (error) {
      logger.warn('share-intent error', { error });
    }
  }, [error]);

  useEffect(() => {
    if (!enabled || !hasShareIntent || processingRef.current) return;
    processingRef.current = true;

    const run = async (): Promise<void> => {
      const params: Record<string, string> = {};
      const sharedText = shareIntent.text?.trim();
      const sharedUrl = shareIntent.webUrl?.trim();
      if (sharedText) params.text = sharedText;
      if (sharedUrl) params.url = sharedUrl;

      const mediaFiles = (shareIntent.files ?? [])
        .filter(
          (file) =>
            Boolean(file?.path) &&
            (file.mimeType?.startsWith('image/') || file.mimeType?.startsWith('video/')),
        )
        .slice(0, MAX_SHARE_FILES);

      const uploaded: PendingShareMediaItem[] = [];
      for (const file of mediaFiles) {
        try {
          const result = (await oxyServices.assetUpload({
            uri: file.path,
            type: file.mimeType,
            name: file.fileName ?? undefined,
          })) as { file?: { id?: unknown; contentType?: unknown } } | undefined;
          const id = result?.file?.id;
          if (typeof id === 'string' && id.length > 0) {
            const contentType =
              typeof result?.file?.contentType === 'string'
                ? result.file.contentType
                : file.mimeType;
            uploaded.push({ id, contentType });
          }
        } catch (uploadError) {
          logger.warn('share-intent media upload failed', { error: uploadError });
        }
      }

      if (uploaded.length > 0) {
        setPendingShareMedia(uploaded);
      }

      // Nothing usable (no text, no url, and every media upload failed) — drop.
      if (Object.keys(params).length === 0 && uploaded.length === 0) {
        resetShareIntent();
        processingRef.current = false;
        return;
      }

      router.push({ pathname: '/compose', params });
      resetShareIntent();
      processingRef.current = false;
    };

    void run();
  }, [enabled, hasShareIntent, shareIntent, resetShareIntent, router]);
};
