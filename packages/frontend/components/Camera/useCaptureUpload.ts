import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetUploadStageProgress } from '@oxy.so/core';
import { logger } from '@oxy.so/core/logger';

import { oxyServices } from '@/lib/oxyServices';
import { toComposerMediaType, type ComposerMediaItem } from '@/utils/composeUtils';

/** A capture that has not left the device yet. */
export interface LocalCapture {
  /** `file://` URI of the photo or video the camera just wrote. */
  uri: string;
  kind: 'image' | 'video';
  /** Best-known MIME type. The server re-derives its own; this is the hint. */
  mimeType: string;
}

/**
 * A capture, uploaded, as the composer's own media item.
 *
 * `ComposerMediaItem.id` is an OXY FILE ID, not a local URI — every path into
 * the composer's media state uploads first (`utils/composeUtils.ts`). So the
 * upload is not an implementation detail of publishing, it is the step that
 * turns a capture into something either exit can use.
 */
export interface UploadedCapture {
  media: ComposerMediaItem;
  contentType: string;
}

/**
 * Upload one capture, once.
 *
 * Both of the review screen's exits need the same upload and neither should pay
 * for it twice, so the result is cached against the URI: publish, change your
 * mind, open the composer instead, and the file is already up.
 *
 * The double-submit guard is a ref rather than the `busy` state, for the reason
 * `lib/shareIntent.native.ts` records at its own upload loop: state lands on the
 * next render and a second press arrives before that.
 */
export function useCaptureUpload(active = true) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState<AssetUploadStageProgress | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      inFlight.current?.abort();
      inFlight.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!active) {
      inFlight.current?.abort();
      inFlight.current = null;
      setBusy(false);
      setProgress(null);
    }
  }, [active]);
  const cache = useRef<{ uri: string; result: UploadedCapture } | null>(null);

  const upload = useCallback(
    async (capture: LocalCapture): Promise<UploadedCapture | null> => {
      if (!active) return null;
      if (cache.current?.uri === capture.uri) return cache.current.result;
      if (inFlight.current) return null;
      const controller = new AbortController();
      inFlight.current = controller;
      setProgress(null);
      setBusy(true);
      setFailed(false);
      try {
        // Upload privately; the authorized publication path decides its audience.
        const response = (await oxyServices.assets.upload(
          {
            uri: capture.uri,
            type: capture.mimeType,
            name: capture.uri.split('/').pop() ?? undefined,
          },
          {
            visibility: 'private',
            signal: controller.signal,
            onStageProgress: (next) => {
              if (controller.signal.aborted) return;
              // Native progress can fire much faster than a visible percentage changes.
              setProgress((previous) =>
                previous?.phase === next.phase &&
                Math.floor((previous.loaded / previous.total) * 100) ===
                  Math.floor((next.loaded / next.total) * 100)
                  ? previous
                  : next,
              );
            },
          },
        )) as { file?: { id?: unknown; contentType?: unknown } } | undefined;

        if (controller.signal.aborted) return null;
        const id = response?.file?.id;
        if (typeof id !== 'string' || id.length === 0) {
          // A response with no id is a failed upload wearing a success's clothes.
          // Publishing a post whose media never arrived is worse than saying so.
          setFailed(true);
          return null;
        }
        const contentType =
          typeof response?.file?.contentType === 'string'
            ? response.file.contentType
            : capture.mimeType;
        const result: UploadedCapture = {
          media: { id, type: toComposerMediaType(capture.kind, contentType) },
          contentType,
        };
        cache.current = { uri: capture.uri, result };
        return result;
      } catch (error) {
        if (controller.signal.aborted) return null;
        logger.warn('capture upload failed', { error });
        setFailed(true);
        return null;
      } finally {
        if (inFlight.current === controller) {
          inFlight.current = null;
          setBusy(false);
          setProgress(null);
        }
      }
    },
    [active],
  );

  const reset = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setBusy(false);
    setProgress(null);
    cache.current = null;
    setFailed(false);
  }, []);

  return { upload, busy, failed, progress, reset };
}
