import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  TextInput,
  Image,
  Dimensions,
} from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { CloseIcon } from '@/assets/icons/close-icon';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';
import { toast } from 'sonner';
import { KLIPY_APP_KEY } from '@/config';

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

const KLIPY_BASE_URL = 'https://api.klipy.com';

const GifPickerSheet: React.FC<GifPickerSheetProps> = ({ onClose, onSelectGif }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const { oxyServices, user } = useOxy();
  const [searchQuery, setSearchQuery] = useState('');
  const [gifs, setGifs] = useState<GifItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedGif, setSelectedGif] = useState<string | number | null>(null);
  const [uploading, setUploading] = useState(false);

  const screenWidth = Dimensions.get('window').width;
  // Calculate size for 3 columns with no spacing, accounting for borders
  // Each item has 1px border on all sides, but adjacent items share borders
  // For 3 columns: left edge (1px) + 2 gaps between items (2px) + right edge (1px) = 4px total
  const borderWidth = 1;
  const numColumns = 3;
  const totalBorderWidth = borderWidth * (numColumns + 1); // numColumns + 1 gaps (including edges)
  const gifSize = Math.floor((screenWidth - totalBorderWidth) / numColumns);

  // Generate a stable customer_id from user ID or use a fallback
  const customerId = user?.id || 'anonymous';

  const fetchGifs = useCallback(async (query: string = '') => {
    if (!KLIPY_APP_KEY) {
      toast.error(t('KLIPY app key not configured'));
      return;
    }

    try {
      setLoading(true);
      
      // Use trending endpoint when no query, search endpoint when there's a query
      const endpoint = query.trim()
        ? `${KLIPY_BASE_URL}/api/v1/${KLIPY_APP_KEY}/gifs/search`
        : `${KLIPY_BASE_URL}/api/v1/${KLIPY_APP_KEY}/gifs/trending`;
      
      const params = new URLSearchParams({
        page: '1',
        per_page: '20',
        customer_id: customerId,
        ...(query.trim() && { q: query.trim() }),
      });

      const response = await fetch(`${endpoint}?${params.toString()}`);
      
      if (!response.ok) {
        throw new Error(`KLIPY API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // Handle KLIPY API response format: { result: true, data: { data: [...] } }
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
  }, [t, customerId]);

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
      const response = await fetch(gifUrl);
      const blob = await response.blob();

      // Create a file object for upload
      // For React Native, we need to create a file-like object
      const filename = `gif_${gif.id}.gif`;
      
      // Convert blob to base64 for React Native compatibility
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
          const base64data = (reader.result as string).split(',')[1];
          resolve(base64data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      const base64 = await base64Promise;
      
      // Create a data URI that can be used as a file URI
      const dataUri = `data:image/gif;base64,${base64}`;
      
      const file = {
        uri: dataUri,
        type: 'image/gif',
        name: filename,
      } as any;

      // Upload via Oxy services
      const uploadResponse = await oxyServices.uploadFile(file, {
        folder: 'user_content',
        isPublic: true,
      });

      if (uploadResponse?.id) {
        await onSelectGif(gifUrl, uploadResponse.id);
        onClose();
      } else {
        throw new Error('Upload failed');
      }
    } catch (error: any) {
      console.error('Error selecting GIF:', error);
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
            width: gifSize, 
            height: gifSize,
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
            <ActivityIndicator size="small" color={theme.colors.primary} />
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
            <HeaderIconButton key="close" onPress={onClose}>
              <CloseIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
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
          <ActivityIndicator size="large" color={theme.colors.primary} />
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
  },
  gifItem: {
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

