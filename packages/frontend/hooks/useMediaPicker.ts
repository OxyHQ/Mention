import { useCallback } from 'react';
import { show as toast } from '@oxyhq/bloom/toast';
import { ComposerMediaItem, toComposerMediaType } from '@/utils/composeUtils';

interface UseMediaPickerProps {
  showBottomSheet?: (config: any) => void;
  setMediaIds: (updater: (prev: ComposerMediaItem[]) => ComposerMediaItem[]) => void;
  t: (key: string) => string;
}

export const useMediaPicker = ({
  showBottomSheet,
  setMediaIds,
  t,
}: UseMediaPickerProps) => {
  const openMediaPicker = useCallback(() => {
    showBottomSheet?.({
      screen: 'FileManagement',
      props: {
        selectMode: true,
        multiSelect: true,
        disabledMimeTypes: ['audio/', 'application/pdf'],
        afterSelect: 'back',
        onSelect: async (file: any) => {
          const isImage = file?.contentType?.startsWith?.('image/');
          const isVideo = file?.contentType?.startsWith?.('video/');
          if (!isImage && !isVideo) {
            toast(t('Please select an image or video file'), { type: 'error' });
            return;
          }
          try {
            const resolvedType = toComposerMediaType(isImage ? 'image' : 'video', file?.contentType);
            const mediaItem: ComposerMediaItem = { id: file.id, type: resolvedType };
            setMediaIds(prev => prev.some(m => m.id === file.id) ? prev : [...prev, mediaItem]);
            toast(t(isImage ? 'Image attached' : 'Video attached'), { type: 'success' });
          } catch (e: any) {
            toast(e?.message || t('Failed to attach media'), { type: 'error' });
          }
        },
        onConfirmSelection: async (files: any[]) => {
          const validFiles = (files || []).filter(f => {
            const contentType = f?.contentType || '';
            return contentType.startsWith('image/') || contentType.startsWith('video/');
          });
          if (validFiles.length !== (files || []).length) {
            toast(t('Please select only image or video files'), { type: 'error' });
          }
          const mediaItems = validFiles.map(f => ({
            id: f.id,
            type: toComposerMediaType(f.contentType?.startsWith('image/') ? 'image' : 'video', f.contentType)
          }));
          setMediaIds(prev => {
            const existingIds = new Set(prev.map(m => m.id));
            const newItems = mediaItems.filter(m => !existingIds.has(m.id));
            return [...prev, ...newItems];
          });
        }
      }
    });
  }, [showBottomSheet, setMediaIds, t]);

  return {
    openMediaPicker,
  };
};
