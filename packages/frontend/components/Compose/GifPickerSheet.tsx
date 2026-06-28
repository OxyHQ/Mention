import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  TextInput,
} from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from '@/assets/icons/close-icon';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { show as toast } from '@oxyhq/bloom/toast';
import VideoPlayer from '@/components/common/VideoPlayer';
import { api } from '@/utils/api';
import { createScopedLogger } from '@/lib/logger';
import { normalizeApiError } from '@/utils/apiError';

const logger = createScopedLogger('GifPickerSheet');

interface GifPickerSheetProps {
  onClose: () => void;
  onSelectGif: (gifUrl: string, gifId: string) => Promise<void>;
}

interface GifItem {
  id: string;
  klipyId: string;
  slug: string;
  title: string;
  mp4Url: string;      // full-size mp4 — attached to the post via /gifs/use
  previewUrl: string;  // small looping muted mp4 for the grid tile
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
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [gifs, setGifs] = useState<GifItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedGif, setSelectedGif] = useState<string | number | null>(null);
  const [uploading, setUploading] = useState(false);

  const numColumns = 3;

  const fetchGifs = useCallback(async (query: string = '') => {
    try {
      setLoading(true);

      // Call backend API instead of KLIPY directly
      const endpoint = query.trim() ? '/gifs/search' : '/gifs/trending';
      const params = query.trim()
        ? { q: query.trim(), page: '1', per_page: '20' }
        : { page: '1', per_page: '20' };

      const response = await api.get<GifSearchResponse>(endpoint, params);
      const items = response.data?.gifs;
      setGifs(Array.isArray(items) ? items : []);
    } catch (error: unknown) {
      logger.error('Error fetching GIFs', { error });
      toast(normalizeApiError(error).message || t('Failed to load GIFs'), { type: 'error' });
      setGifs([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    // Fetch trending GIFs on initial load (empty query = trending)
    fetchGifs('');
  }, [fetchGifs]);

  useEffect(() => {
    const debounceTimer = setTimeout(() => {
      fetchGifs(searchQuery.trim());
    }, 500);

    return () => clearTimeout(debounceTimer);
  }, [searchQuery, fetchGifs]);

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
      logger.error('Error selecting GIF', { error });
      toast(normalizeApiError(error).message || t('Failed to add GIF'), { type: 'error' });
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
          <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.secondary }]} />
        )}
        {isUploading && (
          <View className="absolute inset-0 bg-black/50 justify-center items-center">
            <Loading className="text-primary" size="small" style={{ flex: undefined }} />
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View className="flex-1 bg-background">
      <Header
        options={{
          title: t('Select a GIF'),
          rightComponents: [
            <IconButton variant="icon" key="close" onPress={onClose}>
              <CloseIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <View className="flex-row items-center px-3 py-2.5 mx-4 mt-3 mb-2 rounded-xl bg-secondary gap-2.5">
        <Ionicons name="search" size={20} color={theme.colors.textSecondary} />
        <TextInput
          className="flex-1 text-[15px] text-foreground"
          placeholder={t('Search GIFs...')}
          placeholderTextColor={theme.colors.textTertiary}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <Ionicons name="close-circle" size={20} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {loading && gifs.length === 0 ? (
        <View className="flex-1 justify-center items-center py-12">
          <Loading className="text-primary" size="large" />
          <Text className="mt-3 text-sm text-muted-foreground">
            {t('Loading GIFs...')}
          </Text>
        </View>
      ) : gifs.length === 0 ? (
        <View className="flex-1 justify-center items-center py-12">
          <Ionicons name="image-outline" size={64} color={theme.colors.textSecondary} />
          <Text className="mt-4 text-base text-muted-foreground">
            {t('No GIFs found')}
          </Text>
        </View>
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
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  gifRow: {
    flexDirection: 'row',
    marginBottom: 0,
    width: '100%',
  },
  gifItem: {
    flex: 1,
    aspectRatio: 1,
    overflow: 'hidden',
    backgroundColor: '#f0f0f0',
    borderWidth: 1,
    borderStyle: 'solid',
  },
});

export default GifPickerSheet;
