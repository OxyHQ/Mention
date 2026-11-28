import { useCallback } from 'react';
import { toast } from '@oxy.so/bloom/toast';
import type { FileMetadata } from '@oxy.so/core';
import type { RouteName } from '@oxy.so/services';
import { type ComposerMediaItem, toComposerMediaType } from '@/utils/composeUtils';
import { normalizeApiError } from '@/utils/apiError';

interface UseMediaPickerProps {
  showBottomSheet?: (
    screenOrConfig: RouteName | { screen: RouteName; props?: Record<string, unknown> },
  ) => void;
  t: (key: string) => string;
}

/**
 * Opens the Oxy file manager and hands the chosen images/videos to whoever asked
 * for them.
 *
 * The destination is passed at OPEN time rather than baked into the hook: the
 * composer now has more than one media set — the shared one, and the media a
 * language chooses to show instead — and they must not both live behind one
 * hard-wired setter.
 */
export const useMediaPicker = ({ showBottomSheet, t }: UseMediaPickerProps) => {
  const openMediaPicker = useCallback(
    (
      onAdd: (media: ComposerMediaItem[]) => void,
      { videoOnly = false }: { videoOnly?: boolean } = {},
    ) => {
      showBottomSheet?.({
        screen: 'FileManagement',
        props: {
          selectMode: true,
          multiSelect: !videoOnly,
          disabledMimeTypes: videoOnly
            ? ['image/', 'audio/', 'application/pdf']
            : ['audio/', 'application/pdf'],
          afterSelect: 'back',
          // Keep unpublished media private; previews use Oxy's scoped URLs.
          // Publication applies the author's current audience policy.
          defaultVisibility: 'private',
          onSelect: async (file: FileMetadata) => {
            const isImage = file?.contentType?.startsWith?.('image/');
            const isVideo = file?.contentType?.startsWith?.('video/');
            if ((!isImage && !isVideo) || (videoOnly && !isVideo)) {
              toast(t('compose.media.invalidType'), { type: 'error' });
              return;
            }
            try {
              const resolvedType = toComposerMediaType(
                isImage ? 'image' : 'video',
                file?.contentType,
              );
              onAdd([{ id: file.id, type: resolvedType }]);
              toast(t(isImage ? 'compose.media.imageAttached' : 'compose.media.videoAttached'), {
                type: 'success',
              });
            } catch (e: unknown) {
              toast(normalizeApiError(e).message || t('compose.media.attachFailed'), {
                type: 'error',
              });
            }
          },
          onConfirmSelection: async (files: FileMetadata[]) => {
            const validFiles = (files || []).filter((f) => {
              const contentType = f?.contentType || '';
              return (
                contentType.startsWith('video/') || (!videoOnly && contentType.startsWith('image/'))
              );
            });
            if (validFiles.length !== (files || []).length) {
              toast(t('compose.media.invalidTypes'), { type: 'error' });
            }
            onAdd(
              validFiles.map((f) => ({
                id: f.id,
                type: toComposerMediaType(
                  f.contentType?.startsWith('image/') ? 'image' : 'video',
                  f.contentType,
                ),
              })),
            );
          },
        },
      });
    },
    [showBottomSheet, t],
  );

  return {
    openMediaPicker,
  };
};
