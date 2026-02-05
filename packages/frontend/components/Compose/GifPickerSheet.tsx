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
import { Loading } from '@/components/ui/Loading';
import { useTheme } from '@/hooks/useTheme';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from '@/assets/icons/close-icon';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { toast } from 'sonner';
import { Platform } from 'react-native';
import { api } from '@/utils/api';

interface GifPickerSheetProps {
  onClose: () => void;
  onSelectGif: (gifUrl: string, gifId: string) => Promise<void>;
}

interface GifItem {
  id: string | number;
  slug: string;
  title: string;
  url: string;
  thumbnail: string;
  width: number;
  height: number;
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

      const response = await api.get(endpoint, params);
      const data = response.data;
      
      // Handle backend API response format: { result: true, data: { data: [...] } }
      if (data.result && data.data?.data && Array.isArray(data.data.data)) {
        // Map KLIPY response to our GifItem format
        const mappedGifs: GifItem[] = data.data.data.map((gif: any) => {
          // Use medium size for thumbnail, HD for full GIF
          const thumbnailFile = gif.file?.md || gif.file?.sm || gif.file?.hd;
          const fullFile = gif.file?.hd || gif.file?.md || gif.file?.sm;
          
          return {
            id: gif.id || String(Math.random()),
            slug: gif.slug || '',
            title: gif.title || '',
            url: fullFile?.gif?.url || fullFile?.webp?.url || '',
            thumbnail: thumbnailFile?.gif?.url || thumbnailFile?.webp?.url || thumbnailFile?.jpg?.url || '',
            width: fullFile?.gif?.width || thumbnailFile?.gif?.width || 200,
            height: fullFile?.gif?.height || thumbnailFile?.gif?.height || 200,
          };
        }).filter((gif: GifItem) => gif.url && gif.thumbnail); // Filter out items without URLs
        
        setGifs(mappedGifs);
      } else {
        setGifs([]);
      }
    } catch (error: any) {
      console.error('Error fetching GIFs:', error);
      toast.error(error?.message || t('Failed to load GIFs'));
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

      // Fetch the GIF using the URL from KLIPY
      const gifUrl = gif.url;
      const filename = `gif_${gif.id || gif.slug}.gif`;
      
      if (Platform.OS === 'web') {
        // For web, use fetch and create a File object
        const response = await fetch(gifUrl);
        const blob = await response.blob();
        
        // Create file object for web
        const file = new File([blob], filename, { type: 'image/gif' });
        
        // Upload via Oxy services
        console.log('Uploading GIF file (web):', { filename, type: 'image/gif' });
        const uploadResponse = await oxyServices.uploadFile(file as any, {
          folder: 'user_content',
          isPublic: true,
        });

        console.log('Upload response (web):', uploadResponse);

        // Extract file ID from Oxy response: file.key is the file identifier
        const fileId = uploadResponse?.file?.key || uploadResponse?.id || uploadResponse?.fileId || uploadResponse?.file?.id || uploadResponse?.data?.id;
        
        if (fileId) {
          await onSelectGif(gifUrl, fileId);
          onClose();
          return;
        } else {
          console.error('Upload response structure:', JSON.stringify(uploadResponse, null, 2));
          throw new Error('Upload failed - no file ID returned. Response: ' + JSON.stringify(uploadResponse));
        }
      } else {
        // For React Native, try to use expo-file-system if available, otherwise use direct URL
        let fileUri = gifUrl;
        
        try {
          // Try to use expo-file-system to download the file locally first
          const FileSystem = require('expo-file-system');
          const localUri = `${FileSystem.cacheDirectory}${filename}`;
          
          // Download the GIF file
          const downloadResult = await FileSystem.downloadAsync(gifUrl, localUri);
          
          if (downloadResult.uri) {
            fileUri = downloadResult.uri;
          }
        } catch (fsError) {
          // If expo-file-system is not available, use the remote URL directly
          console.warn('expo-file-system not available, using remote URL:', fsError);
        }

        // Create file object for React Native upload
        const file = {
          uri: fileUri,
          type: 'image/gif',
          name: filename,
        } as any;

        // Upload via Oxy services
        console.log('Uploading GIF file:', { uri: file.uri, type: file.type, name: file.name });
        const uploadResponse = await oxyServices.uploadFile(file, {
          folder: 'user_content',
          isPublic: true,
        });

        console.log('Upload response:', uploadResponse);

        // Extract file ID from Oxy response: file.key is the file identifier
        const fileId = uploadResponse?.file?.key || uploadResponse?.id || uploadResponse?.fileId || uploadResponse?.file?.id || uploadResponse?.data?.id;
        
        if (fileId) {
          await onSelectGif(gifUrl, fileId);
          onClose();
        } else {
          console.error('Upload response structure:', JSON.stringify(uploadResponse, null, 2));
          throw new Error('Upload failed - no file ID returned. Response: ' + JSON.stringify(uploadResponse));
        }
      }
    } catch (error: any) {
      console.error('Error selecting GIF:', error);
      console.error('Error details:', JSON.stringify(error, null, 2));
      toast.error(error?.message || t('Failed to add GIF'));
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
          { 
            borderColor: isSelected ? theme.colors.primary : theme.colors.border,
          },
          isSelected && { opacity: 0.7 },
        ]}
        onPress={() => handleSelectGif(item)}
        disabled={uploading}
        activeOpacity={0.8}
      >
        <Image
          source={{ uri: item.thumbnail || item.url }}
          style={styles.gifImage}
          resizeMode="cover"
        />
        {isUploading && (
          <View style={styles.uploadingOverlay}>
            <Loading size="small" style={{ flex: undefined }} />
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Header
        options={{
          title: t('Select a GIF'),
          rightComponents: [
            <IconButton variant="icon" key="close" onPress={onClose}>
              <CloseIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <View style={[styles.searchContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <Ionicons name="search" size={20} color={theme.colors.textSecondary} />
        <TextInput
          style={[styles.searchInput, { color: theme.colors.text }]}
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
        <View style={styles.loadingContainer}>
          <Loading size="large" />
          <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
            {t('Loading GIFs...')}
          </Text>
        </View>
      ) : gifs.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Ionicons name="image-outline" size={64} color={theme.colors.textSecondary} />
          <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
            {t('No GIFs found')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={gifs}
          renderItem={renderGifItem}
          keyExtractor={(item) => String(item.id)}
          numColumns={numColumns}
          contentContainerStyle={styles.gifList}
          columnWrapperStyle={styles.gifRow}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    borderRadius: 12,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 48,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 48,
  },
  emptyText: {
    marginTop: 16,
    fontSize: 16,
  },
  gifList: {
    padding: 0,
  },
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
  gifImage: {
    width: '100%',
    height: '100%',
  },
  uploadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default GifPickerSheet;

