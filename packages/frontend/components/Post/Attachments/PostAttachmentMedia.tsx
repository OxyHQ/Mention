import React, { useEffect, useState } from 'react';
import { Image, View, StyleSheet, ViewStyle, Platform } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { LazyImage } from '@/components/ui/LazyImage';
import VideoPlayer from '@/components/common/VideoPlayer';

const webGrabCursorStyle: ViewStyle | null = Platform.OS === 'web'
  ? ({ cursor: 'grab' } as unknown as ViewStyle)
  : null;

const CARD_WIDTH = 280;
const CARD_HEIGHT = 180;

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

const MIN_WIDTH = 100;

const PostAttachmentImage: React.FC<{
  src: string;
  hasSingleMedia?: boolean;
  hasMultipleMedia?: boolean;
}> = ({ src }) => {
  const theme = useTheme();
  const [aspectRatio, setAspectRatio] = useState<number | undefined>(undefined);

  useEffect(() => {
    Image.getSize(
      src,
      (width, height) => {
        if (width > 0 && height > 0) {
          setAspectRatio(width / height);
        }
      },
      () => {
        setAspectRatio(4 / 3);
      }
    );
  }, [src]);

  const computedWidth = aspectRatio !== undefined
    ? Math.max(CARD_HEIGHT * aspectRatio, MIN_WIDTH)
    : CARD_WIDTH;

  return (
    <LazyImage
      source={{ uri: src }}
      containerStyle={[
        styles.itemContainer,
        webGrabCursorStyle,
        { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary,
          height: CARD_HEIGHT, width: computedWidth },
      ]}
      style={{ width: '100%' as unknown as number, height: '100%' as unknown as number }}
      resizeMode="cover"
      placeholder={
        <View
          className="bg-secondary justify-center items-center"
          style={{ width: computedWidth, height: CARD_HEIGHT }}
        />
      }
      threshold={300}
    />
  );
};

const PostAttachmentMedia: React.FC<PostAttachmentMediaProps> = ({
  type,
  src,
  mediaId,
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

  return (
    <PostAttachmentImage
      src={src}
      hasSingleMedia={hasSingleMedia}
      hasMultipleMedia={hasMultipleMedia}
    />
  );
};

const styles = StyleSheet.create({
  itemContainer: {
    borderWidth: 1,
    borderRadius: 15,
    overflow: 'hidden',
  },
  videoPreserveAspect: {
    width: CARD_WIDTH,
  },
  videoMultipleMedia: {
    height: CARD_HEIGHT,
    alignSelf: 'flex-start',
  },
});

export default PostAttachmentMedia;
