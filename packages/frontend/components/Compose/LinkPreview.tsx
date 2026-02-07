import React from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { LinkMetadata } from '../../stores/linksStore';
import { useTheme } from '@/hooks/useTheme';
import { CloseIcon } from '@/assets/icons/close-icon';
import { MEDIA_CARD_HEIGHT } from '@/utils/composeUtils';
import { getApiOrigin } from '@/utils/api';

/**
 * Fix image URL to use correct API port (3000 for localhost)
 */
function fixImageUrl(imageUrl: string | undefined): string | undefined {
  if (!imageUrl) return imageUrl;
  
  // Already absolute and not a cached image - use as-is
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    // If it's a cached image URL with wrong port, fix it
    if (imageUrl.includes('/links/images/')) {
      const apiOrigin = getApiOrigin();
      const pathMatch = imageUrl.match(/\/links\/images\/.+$/);
      if (pathMatch) {
        return `${apiOrigin}${pathMatch[0]}`;
      }
    }
    return imageUrl;
  }
  
  // Relative URL - construct absolute URL with correct port
  if (imageUrl.startsWith('/links/images/') || imageUrl.startsWith('/')) {
    return `${getApiOrigin()}${imageUrl}`;
  }
  
  return imageUrl;
}

interface LinkPreviewProps {
  link: LinkMetadata;
  onRemove?: () => void;
  style?: any;
}

export const LinkPreview: React.FC<LinkPreviewProps> = React.memo(({ link, onRemove, style }) => {
  const theme = useTheme();

  const handlePress = React.useCallback(async () => {
    try {
      const supported = await Linking.canOpenURL(link.url);
      if (supported) {
        await Linking.openURL(link.url);
      }
    } catch (error) {
      // Silently handle errors - user can manually open if needed
    }
  }, [link.url]);

  const { displayTitle, displayDescription, displaySiteName } = React.useMemo(() => {
    let title = link.title || link.siteName;
    let description = link.description || '';
    let siteName = link.siteName;

    try {
      const urlObj = new URL(link.url);
      if (!siteName) {
        siteName = urlObj.hostname.replace('www.', '');
      }
      if (!title) {
        title = urlObj.hostname;
      }
    } catch (e) {
      // Invalid URL, use fallback
      if (!siteName) {
        siteName = 'Link';
      }
      if (!title) {
        title = link.url;
      }
    }

    return { displayTitle: title, displayDescription: description, displaySiteName: siteName };
  }, [link.title, link.siteName, link.description, link.url]);

  return (
    <TouchableOpacity
      style={[
        styles.container,
        {
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.backgroundSecondary,
        },
        style,
      ]}
      activeOpacity={0.85}
      onPress={handlePress}
    >
      {link.image ? (
        <Image
          source={{ uri: fixImageUrl(link.image) }}
          style={styles.image}
          resizeMode="cover"
          onError={() => {
            // Image will just not display if it fails - silently handle
          }}
        />
      ) : null}

      <View style={styles.content}>
        {displaySiteName ? (
          <Text
            style={[styles.siteName, { color: theme.colors.textSecondary }]}
            numberOfLines={1}
          >
            {displaySiteName}
          </Text>
        ) : null}

        {displayTitle ? (
          <Text
            style={[styles.title, { color: theme.colors.text }]}
            numberOfLines={2}
          >
            {displayTitle}
          </Text>
        ) : null}

        {displayDescription ? (
          <Text
            style={[styles.description, { color: theme.colors.textSecondary }]}
            numberOfLines={2}
          >
            {displayDescription}
          </Text>
        ) : null}
      </View>

      {onRemove && (
        <TouchableOpacity
          onPress={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={[styles.removeButton, { backgroundColor: theme.colors.background }]}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <CloseIcon size={16} color={theme.colors.text} />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}, (prevProps, nextProps) => {
  // Custom comparison for memo
  return (
    prevProps.link.url === nextProps.link.url &&
    prevProps.link.title === nextProps.link.title &&
    prevProps.link.description === nextProps.link.description &&
    prevProps.link.image === nextProps.link.image &&
    prevProps.link.siteName === nextProps.link.siteName &&
    prevProps.onRemove === nextProps.onRemove
  );
});

interface LinkPreviewLoadingProps {
  style?: any;
}

export const LinkPreviewLoading: React.FC<LinkPreviewLoadingProps> = ({ style }) => {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.container,
        {
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.backgroundSecondary,
        },
        style,
      ]}
    >
      <View style={styles.loadingContent}>
        <Loading size="small" style={{ flex: undefined }} />
        <Text style={[styles.loadingText, { color: theme.colors.textSecondary, marginLeft: 8 }]}>
          Loading preview...
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 15,
    borderWidth: 0, // Border handled by wrapper
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
    maxHeight: MEDIA_CARD_HEIGHT, // Match media card height (180px)
    height: MEDIA_CARD_HEIGHT, // Fixed height to match media cards
  },
  image: {
    flex: 1,
    width: '100%',
    backgroundColor: '#EFEFEF',
    minHeight: 50,
  },
  content: {
    padding: 12,
  },
  siteName: {
    fontSize: 12,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    marginTop: 4,
  },
  description: {
    fontSize: 13,
    marginTop: 4,
    lineHeight: 18,
  },
  removeButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 999,
    padding: 6,
  },
  loadingContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  loadingText: {
    fontSize: 13,
  },
});

