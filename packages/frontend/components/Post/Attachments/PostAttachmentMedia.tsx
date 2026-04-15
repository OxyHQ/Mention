import React, { useEffect, useState } from 'react';
import { Image, View, StyleSheet, ViewStyle, Platform } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { LazyImage } from '@/components/ui/LazyImage';
import VideoPlayer from '@/components/common/VideoPlayer';
import { MEDIA_CARD_WIDTH, MEDIA_CARD_HEIGHT } from '@/utils/composeUtils';

const webGrabCursorStyle: ViewStyle | null = Platform.OS === 'web'
  ? ({ cursor: 'grab' } as unknown as ViewStyle)
  : null;

const MIN_WIDTH = 100;

const aspectRatioCache = new Map<string, number>();

interface PostAttachmentMediaProps {
  type: 'image' | 'video' | 'gif';
  src: string;
  mediaId?: string;
  postId?: string;
  onPress?: () => void;
  hasSingleMedia?: boolean;
  hasMultipleMedia?: boolean;
}

const PostAttachmentVideo: React.FC<{
  src: string;
  postId?: string;
  onPress?: () => void;
  hasSingleMedia?: boolean;
  hasMultipleMedia?: boolean;
}> = ({ src, postId, onPress, hasSingleMedia, hasMultipleMedia }) => {
  return (
    <View
      className="border border-border bg-secondary rounded-[15px] overflow-hidden"
      style={[
        webGrabCursorStyle,
        hasMultipleMedia && { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' as const },
        hasSingleMedia && { maxHeight: undefined, height: undefined },
      ]}
    >
      <VideoPlayer
        src={src}
        style={hasSingleMedia ? styles.videoPreserveAspect : styles.videoMultipleMedia}
        contentFit="contain"
        autoPlay={true}
        loop={true}
      />
    </View>
  );
};

const PostAttachmentImage: React.FC<{
  src: string;
}> = ({ src }) => {
  const theme = useTheme();
  const [aspectRatio, setAspectRatio] = useState<number | undefined>(
    () => aspectRatioCache.get(src)
  );

  useEffect(() => {
    if (aspectRatioCache.has(src)) {
      setAspectRatio(aspectRatioCache.get(src));
      return;
    }
    let cancelled = false;
    Image.getSize(
      src,
      (width, height) => {
        if (cancelled) return;
        if (width > 0 && height > 0) {
          const ratio = width / height;
          aspectRatioCache.set(src, ratio);
          setAspectRatio(ratio);
        }
      },
      () => {
        if (cancelled) return;
        const fallback = 4 / 3;
        aspectRatioCache.set(src, fallback);
        setAspectRatio(fallback);
      }
    );
    return () => { cancelled = true; };
  }, [src]);

  const computedWidth = aspectRatio !== undefined
    ? Math.max(MEDIA_CARD_HEIGHT * aspectRatio, MIN_WIDTH)
    : MEDIA_CARD_WIDTH;

  const containerStyles: ViewStyle[] = [
    styles.itemContainer,
    {
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.backgroundSecondary,
      height: MEDIA_CARD_HEIGHT,
      width: computedWidth,
    },
  ];
  if (webGrabCursorStyle) {
    containerStyles.push(webGrabCursorStyle);
  }

  return (
    <LazyImage
      source={{ uri: src }}
      containerStyle={containerStyles}
      style={{ width: '100%' as unknown as number, height: '100%' as unknown as number }}
      resizeMode="cover"
      placeholder={
        <View
          className="bg-secondary justify-center items-center"
          style={{ width: computedWidth, height: MEDIA_CARD_HEIGHT }}
        />
      }
      threshold={300}
    />
  );
};

const PostAttachmentMedia: React.FC<PostAttachmentMediaProps> = ({
  type,
  src,
  postId,
  onPress,
  hasSingleMedia,
  hasMultipleMedia,
}) => {
  if (type === 'video') {
    return (
      <PostAttachmentVideo
        src={src}
        postId={postId}
        onPress={onPress}
        hasSingleMedia={hasSingleMedia}
        hasMultipleMedia={hasMultipleMedia}
      />
    );
  }

  return <PostAttachmentImage src={src} />;
};

const styles = StyleSheet.create({
  itemContainer: {
    borderWidth: 1,
    borderRadius: 15,
    overflow: 'hidden',
  },
  videoPreserveAspect: {
    width: MEDIA_CARD_WIDTH,
  },
  videoMultipleMedia: {
    height: MEDIA_CARD_HEIGHT,
    alignSelf: 'flex-start',
  },
});

export default PostAttachmentMedia;
