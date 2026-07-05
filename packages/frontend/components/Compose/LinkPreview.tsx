import React from 'react';
import { View, Text, Image, StyleSheet, TouchableOpacity, Linking, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { Loading } from '@oxyhq/bloom/loading';
import { LinkMetadata } from '../../stores/linksStore';
import { useTheme } from '@oxyhq/bloom/theme';
import { CloseIcon } from '@/assets/icons/close-icon';
import { useTranslation } from 'react-i18next';
import { composePreviewEnter, composePreviewExit } from '@/lib/animations/entryExit';
import { MEDIA_CARD_HEIGHT } from '@/utils/composeUtils';
import { getApiOrigin } from '@/utils/api';

const LINK_PREVIEW_IMAGE_MAX_WIDTH = 600;
const LINK_PREVIEW_IMAGE_MAX_HEIGHT = 315;
const LINK_PREVIEW_IMAGE_QUALITY = 75;

function getOptimizedExternalImageUrl(imageUrl: string): string {
  const params = new URLSearchParams({
    url: imageUrl,
    w: String(LINK_PREVIEW_IMAGE_MAX_WIDTH),
    h: String(LINK_PREVIEW_IMAGE_MAX_HEIGHT),
    q: String(LINK_PREVIEW_IMAGE_QUALITY),
  });
  return `${getApiOrigin()}/images/optimize?${params.toString()}`;
}

/**
 * Resolve a link-preview image URL for display.
 *
 * Link previews carry an `image` that is often hosted on the EXTERNAL site (e.g.
 * an og:image). Hot-linking that on web breaks for CORS-restricted hosts and dies
 * when the upstream link expires, so external absolute URLs are routed through our
 * bounded image optimizer, which serves them same-origin, cached, resized, and
 * CORS-safe. Own-origin URLs — including our cached `/links/images/` previews —
 * are returned unchanged. Relative paths are resolved against the API origin
 * first (handles localhost port + cached previews).
 */
function fixImageUrl(imageUrl: string | undefined): string | undefined {
  if (!imageUrl) return imageUrl;

  // Absolute URL: keep our cached/optimized previews on the right origin, otherwise optimize it.
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    try {
      const parsed = new URL(imageUrl);
      const apiOrigin = getApiOrigin();

      // Already optimized/cached by our backend: keep the final URL to avoid an
      // optimizer loop or a needless second optimization pass.
      if (parsed.origin === apiOrigin && parsed.pathname === '/images/optimize') {
        return imageUrl;
      }
    } catch {
      // If parsing somehow fails despite the prefix check, fall through to the
      // optimizer path; the backend will validate and reject malformed URLs.
    }

    // If it's our cached preview image with the wrong port/origin, normalize it.
    if (imageUrl.includes('/links/images/')) {
      const apiOrigin = getApiOrigin();
      const pathMatch = imageUrl.match(/\/links\/images\/.+$/);
      if (pathMatch) {
        return `${apiOrigin}${pathMatch[0]}`;
      }
    }
    // External image → route through the bounded image optimizer instead of the
    // general media proxy. Link previews render as thumbnails, so using the
    // streaming proxy would make viewers fetch the full attacker-controlled
    // object even for tiny cards.
    return getOptimizedExternalImageUrl(imageUrl);
  }

  // Relative URL - construct absolute URL on our origin (correct port locally).
  if (imageUrl.startsWith('/links/images/') || imageUrl.startsWith('/')) {
    return `${getApiOrigin()}${imageUrl}`;
  }

  return imageUrl;
}

interface LinkPreviewProps {
  link: LinkMetadata;
  onRemove?: () => void;
  style?: StyleProp<ViewStyle>;
}

export const LinkPreview: React.FC<LinkPreviewProps> = React.memo(({ link, onRemove, style }) => {
  const theme = useTheme();

  const handlePress = React.useCallback(async () => {
    try {
      const supported = await Linking.canOpenURL(link.url);
      if (supported) {
        await Linking.openURL(link.url);
      }
    } catch {
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
    } catch {
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
    <Animated.View entering={composePreviewEnter} exiting={composePreviewExit}>
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
            className="flex-1 w-full min-h-[50px] bg-[#EFEFEF]"
            resizeMode="cover"
            onError={() => {
              // Image will just not display if it fails - silently handle
            }}
          />
        ) : null}

        <View className="p-3">
          {displaySiteName ? (
            <Text
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
              numberOfLines={1}
            >
              {displaySiteName}
            </Text>
          ) : null}

          {displayTitle ? (
            <Text
              className="text-[15px] font-semibold text-foreground mt-1"
              numberOfLines={2}
            >
              {displayTitle}
            </Text>
          ) : null}

          {displayDescription ? (
            <Text
              className="text-[13px] text-muted-foreground mt-1"
              style={{ lineHeight: 18 }}
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
            className="absolute top-2 right-2 rounded-full p-1.5 bg-background"
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            <CloseIcon size={16} className="text-foreground" />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    </Animated.View>
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

LinkPreview.displayName = 'LinkPreview';

interface LinkPreviewLoadingProps {
  style?: StyleProp<ViewStyle>;
}

export const LinkPreviewLoading: React.FC<LinkPreviewLoadingProps> = ({ style }) => {
  const theme = useTheme();
  const { t } = useTranslation();

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
      <View className="flex-row items-center justify-center p-4">
        <Loading className="text-primary" size="small" style={{ flex: undefined }} />
        <Text className="text-[13px] text-muted-foreground ml-2">
          {t('compose.linkPreview.loading', { defaultValue: 'Loading preview...' })}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    borderRadius: 15,
    borderWidth: 0,
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
    maxHeight: MEDIA_CARD_HEIGHT,
    height: MEDIA_CARD_HEIGHT,
  },
});
