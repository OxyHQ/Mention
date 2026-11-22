import { MediaGridSkeleton } from '@/components/loading/ContentSkeleton';
import { useDebouncedValue } from '@oxy.so/bloom/hooks';
import type React from 'react';
import { useState } from 'react';
import { View, StyleSheet, TouchableOpacity, FlatList } from 'react-native';
import { useColorTokens, useTheme } from '@oxy.so/bloom/theme';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiImageLine } from '@oxy.so/bloom/icons/RiImageLine';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import VideoPlayer from '@/components/common/VideoPlayer';
import { api, authenticatedClient } from '@/utils/api';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { createLogger } from '@oxy.so/core/logger';
import { normalizeApiError } from '@/utils/apiError';

import {
  Button as LButton,
  Embed,
  Header,
  Icon,
  Loading,
  RawText,
  Search as LSearch,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const logger = createLogger('GifPickerSheet');

interface GifPickerSheetProps {
  onClose: () => void;
  onSelectGif: (gifUrl: string, gifId: string) => Promise<void>;
}

interface GifItem {
  id: string;
  klipyId: string;
  slug: string;
  title: string;
  mp4Url: string; // full-size mp4 — attached to the post via /gifs/use
  previewUrl: string; // small looping muted mp4 for the grid tile
  width: number;
  height: number;
}

interface GifSearchResponse {
  gifs: GifItem[];
  hasNext: boolean;
  page: number;
}

const GifPickerSheet: React.FC<GifPickerSheetProps> = ({ onClose, onSelectGif }) => {
  const theme = useTheme();
  const colorTokens = useColorTokens();
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const { user, canUsePrivateApi } = useAuth();
  const [selectedGif, setSelectedGif] = useState<string | number | null>(null);
  const [uploading, setUploading] = useState(false);

  const numColumns = 3;

  const debouncedQuery = useDebouncedValue(searchQuery.trim(), 500);

  const search = useQuery({
    queryKey: viewerQueryKeys.gifSearch(user?.id, canUsePrivateApi, debouncedQuery),
    enabled: canUsePrivateApi,
    queryFn: async ({ signal }) => {
      const response = await authenticatedClient.get<GifSearchResponse>(
        debouncedQuery ? '/gifs/search' : '/gifs/trending',
        {
          params: { ...(debouncedQuery ? { q: debouncedQuery } : {}), page: '1', per_page: '20' },
          signal,
        },
      );
      return Array.isArray(response.data?.gifs) ? response.data.gifs : [];
    },
    staleTime: 60_000,
    retry: false,
  });
  const isDebouncing = searchQuery.trim() !== debouncedQuery;
  const loading = isDebouncing || search.isPending;
  const gifs = isDebouncing ? [] : (search.data ?? []);

  const handleSelectGif = async (gif: GifItem) => {
    if (uploading) return;

    try {
      setSelectedGif(gif.id);
      setUploading(true);

      // The backend imports/normalizes the GIF and returns the SHARED Oxy file id
      // to attach to the post — no client-side download or upload.
      const res = await api.post<{ gifId: string; fileId: string; mp4Url: string }>('/gifs/use', {
        klipyId: gif.klipyId,
        slug: gif.slug,
        title: gif.title,
        mp4Url: gif.mp4Url,
        previewUrl: gif.previewUrl,
        width: gif.width,
        height: gif.height,
      });

      const fileId = res.data?.fileId;
      if (!fileId) throw new Error('GIF use failed - no file id');

      await onSelectGif(res.data.mp4Url, fileId);
      onClose();
    } catch (error: unknown) {
      logger.error('Error selecting GIF', error);
      toast(normalizeApiError(error).message || t('compose.gif.addFailed'), { type: 'error' });
    } finally {
      setUploading(false);
      setSelectedGif(null);
    }
  };

  const renderGifItem = ({ item }: { item: GifItem }) => {
    const isSelected = selectedGif === item.id || selectedGif === item.slug;
    const isUploading = uploading && isSelected;

    return (
      <TouchableOpacity
        style={[
          { backgroundColor: colorTokens.surface },
          styles.gifItem,
          { borderColor: isSelected ? theme.colors.primary : theme.colors.border },
          isSelected && { opacity: 0.7 },
        ]}
        onPress={() => handleSelectGif(item)}
        disabled={uploading}
        activeOpacity={0.8}
      >
        {item.previewUrl ? (
          <VideoPlayer
            src={item.previewUrl}
            autoPlay
            loop
            gif
            contentFit="cover"
            style={StyleSheet.absoluteFill}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.contrast50 }]} />
        )}
        {isUploading && <View style={styles.uploading}>{toElement(Loading().size('sm'))}</View>}
      </TouchableOpacity>
    );
  };

  return toElement(
    VStack(
      Header(t('compose.gif.title'))
        .safeArea(false)
        .toolbar(
          LButton(Icon(RiCloseLine))
            .shape('circle')
            .style('subtle')
            .tint('neutral')
            .onPress(onClose)
            .label(t('common.close', { defaultValue: 'Close' })),
        )
        .inPage(),
      VStack(
        LSearch([searchQuery, setSearchQuery])
          .label(t('compose.gif.searchPlaceholder'))
          .onClearText(() => setSearchQuery(''))
          .autocapitalize('none')
          .autocorrect(false),
      )
        .margin('horizontal', 'lg')
        .margin('top', 'md')
        .margin('bottom', 'sm'),
      Embed(
        loading ? (
          toElement(
            VStack(
              Embed(<MediaGridSkeleton />),
              RawText(t('compose.gif.loading'))
                .margin('top', 'md')
                .font('14')
                .leading('20px')
                .foreground('muted'),
            )
              .padding('vertical', '48')
              .flex('1')
              .justify('center')
              .align('center'),
          )
        ) : search.isError ? (
          toElement(
            VStack(
              RawText(t('compose.gif.loadFailed')).foreground('muted').role('alert'),
              LButton(LText(t('common.retry'))).onPress(() => void search.refetch()),
            )
              .padding('vertical', '48')
              .flex('1')
              .align('center')
              .justify('center')
              .spacing('md'),
          )
        ) : gifs.length === 0 ? (
          toElement(
            VStack(
              Icon(RiImageLine).size('64').foreground('muted'),
              RawText(t('compose.gif.empty'))
                .margin('top', 'lg')
                .font('16')
                .leading('normal')
                .foreground('muted'),
            )
              .padding('vertical', '48')
              .flex('1')
              .justify('center')
              .align('center'),
          )
        ) : (
          <FlatList
            data={gifs}
            renderItem={renderGifItem}
            keyExtractor={(item) => String(item.id)}
            numColumns={numColumns}
            contentContainerStyle={{ padding: 0 }}
            columnWrapperStyle={styles.gifRow}
            showsVerticalScrollIndicator={false}
          />
        ),
      ),
    )
      .background('background')
      .flex('1'),
  );
};

const styles = StyleSheet.create({
  gifRow: {
    flexDirection: 'row',
    marginBottom: 0,
    width: '100%',
  },
  // Tailwind's `absolute inset-0 bg-black/50`: one `inset`, which the language's
  // `.position()` writes as four edges.
  uploading: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  gifItem: {
    flex: 1,
    aspectRatio: 1,
    overflow: 'hidden',
    borderWidth: 1,
    borderStyle: 'solid',
  },
});

export default GifPickerSheet;
