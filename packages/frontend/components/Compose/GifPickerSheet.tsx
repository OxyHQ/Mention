import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  TextInput,
  Image,
} from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from '@/assets/icons/close-icon';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { show as toast } from '@oxyhq/bloom/toast';
import { Platform } from 'react-native';
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
  slug: string;
  title: string;
  url: string;        // full-size animated gif — upload fallback
  mp4Url: string;     // mp4 video — preferred upload (≈10–20× smaller, full color)
  thumbnail: string;  // grid thumbnail
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
  const { oxyServices, user } = useAuth();
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

      // Prefer the MP4 (≈10–20× smaller, full color, hardware-decoded) — it renders
      // as an inline looping muted video, like X/Meta. Fall back to the animated gif
      // when the backend didn't supply an mp4.
      const uploadUrl = gif.mp4Url || gif.url;
      const isMp4 = Boolean(gif.mp4Url);
      const filename = `gif_${gif.id || gif.slug}.${isMp4 ? 'mp4' : 'gif'}`;

      if (Platform.OS === 'web') {
        // For web, use fetch and create a File object
        const response = await fetch(uploadUrl);
        const blob = await response.blob();

        // Create file object for web
        const file = new File([blob], filename, { type: isMp4 ? 'video/mp4' : 'image/gif' });

        // Upload via Oxy services
        logger.debug(`Uploading GIF file (web): ${filename}`);
        const uploadResponse = await oxyServices.uploadRawFile(file, 'public', {
          folder: 'user_content',
        });

        logger.debug('Upload response (web) received');

        // Extract file ID from Oxy response: file.key is the file identifier
        const fileId = uploadResponse?.file?.key || uploadResponse?.id || uploadResponse?.fileId || uploadResponse?.file?.id || uploadResponse?.data?.id;

        if (fileId) {
          await onSelectGif(uploadUrl, fileId);
          onClose();
          return;
        } else {
          logger.error('Upload failed - no file ID returned');
          throw new Error('Upload failed - no file ID returned');
        }
      } else {
        // For React Native, try to use expo-file-system if available, otherwise use direct URL
        let fileUri = uploadUrl;

        try {
          // Try to use expo-file-system to download the file locally first
          const FileSystem = require('expo-file-system');
          const localUri = `${FileSystem.cacheDirectory}${filename}`;

          // Download the file
          const downloadResult = await FileSystem.downloadAsync(uploadUrl, localUri);

          if (downloadResult.uri) {
            fileUri = downloadResult.uri;
          }
        } catch (fsError) {
          // If expo-file-system is not available, use the remote URL directly
          logger.warn('expo-file-system not available, using remote URL');
        }

        // Create file object for React Native upload
        const file = {
          uri: fileUri,
          type: isMp4 ? 'video/mp4' : 'image/gif',
          name: filename,
        };

        // Upload via Oxy services
        logger.debug(`Uploading GIF file: ${file.name}`);
        const uploadResponse = await oxyServices.uploadRawFile(file, 'public', {
          folder: 'user_content',
        });

        logger.debug('Upload response received');

        // Extract file ID from Oxy response: file.key is the file identifier
        const fileId = uploadResponse?.file?.key || uploadResponse?.id || uploadResponse?.fileId || uploadResponse?.file?.id || uploadResponse?.data?.id;

        if (fileId) {
          await onSelectGif(uploadUrl, fileId);
          onClose();
        } else {
          logger.error('Upload failed - no file ID returned');
          throw new Error('Upload failed - no file ID returned');
        }
      }
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
        <Image
          source={{ uri: item.thumbnail || item.url }}
          className="w-full h-full"
          resizeMode="cover"
        />
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
