import { useCallback } from 'react';
import { show as toast } from '@oxyhq/bloom/toast';
import type { FileMetadata } from '@oxyhq/core';
import type { RouteName } from '@oxyhq/services';
import { ComposerMediaItem, toComposerMediaType } from '@/utils/composeUtils';
import { normalizeApiError } from '@/utils/apiError';

interface UseMediaPickerProps {
  showBottomSheet?: (screenOrConfig: RouteName | { screen: RouteName; props?: Record<string, unknown> }) => void;
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
    (onAdd: (media: ComposerMediaItem[]) => void) => {
      showBottomSheet?.({
        screen: 'FileManagement',
        props: {
          selectMode: true,
          multiSelect: true,
          disabledMimeTypes: ['audio/', 'application/pdf'],
          afterSelect: 'back',
          onSelect: async (file: FileMetadata) => {
            const isImage = file?.contentType?.startsWith?.('image/');
            const isVideo = file?.contentType?.startsWith?.('video/');
            if (!isImage && !isVideo) {
              toast(t('Please select an image or video file'), { type: 'error' });
              return;
            }
            try {
              const resolvedType = toComposerMediaType(isImage ? 'image' : 'video', file?.contentType);
              onAdd([{ id: file.id, type: resolvedType }]);
              toast(t(isImage ? 'Image attached' : 'Video attached'), { type: 'success' });
            } catch (e: unknown) {
              toast(normalizeApiError(e).message || t('Failed to attach media'), { type: 'error' });
            }
          },
          onConfirmSelection: async (files: FileMetadata[]) => {
            const validFiles = (files || []).filter(f => {
              const contentType = f?.contentType || '';
              return contentType.startsWith('image/') || contentType.startsWith('video/');
            });
            if (validFiles.length !== (files || []).length) {
              toast(t('Please select only image or video files'), { type: 'error' });
            }
            onAdd(validFiles.map(f => ({
              id: f.id,
              type: toComposerMediaType(f.contentType?.startsWith('image/') ? 'image' : 'video', f.contentType),
            })));
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
