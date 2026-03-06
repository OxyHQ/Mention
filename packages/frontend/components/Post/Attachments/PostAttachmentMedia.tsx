import React, { useEffect, useState } from 'react';
import { Image, View, StyleSheet, ViewStyle, Platform } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
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
  borderColor: string;
  backgroundColor: string;
  postId?: string;
  onPress?: () => void;
  hasSingleMedia?: boolean;
  hasMultipleMedia?: boolean;
}> = ({ src, borderColor, backgroundColor, postId, onPress, hasSingleMedia, hasMultipleMedia }) => {
  return (
    <View style={[
      styles.itemContainer,
      webGrabCursorStyle,
      { borderColor, backgroundColor },
      hasMultipleMedia && { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' },
      hasSingleMedia && { maxHeight: undefined, height: undefined }
    ]}>
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
  borderColor: string;
  backgroundColor: string;
  hasSingleMedia?: boolean;
  hasMultipleMedia?: boolean;
}> = ({ src, borderColor, backgroundColor, hasSingleMedia, hasMultipleMedia }) => {
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
        // On error, use default aspect ratio
        setAspectRatio(hasMultipleMedia ? 4 / 3 : 4 / 3);
      }
    );
  }, [src, hasMultipleMedia]);

  return (
    <LazyImage
      source={{ uri: src }}
      containerStyle={[
        styles.itemContainer,
        webGrabCursorStyle,
        { borderColor, backgroundColor },
        hasMultipleMedia && { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' },
        hasSingleMedia && { maxHeight: undefined, height: undefined }
      ]}
      style={[
        hasSingleMedia ? styles.imagePreserveAspect : styles.imageMultipleMedia,
        aspectRatio !== undefined ? { aspectRatio } : undefined
      ]}
      resizeMode="contain"
      placeholder={
        <View style={[
          hasSingleMedia ? styles.imagePreserveAspect : styles.imageMultipleMedia,
          { backgroundColor, justifyContent: 'center', alignItems: 'center' }
        ]} />
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
  const theme = useTheme();

  if (type === 'video') {
    return (
      <PostAttachmentVideo
        src={src}
        borderColor={theme.colors.border}
        backgroundColor={theme.colors.backgroundSecondary}
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
      borderColor={theme.colors.border}
      backgroundColor={theme.colors.backgroundSecondary}
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
    // No height or aspectRatio constraint - height determined by video's natural aspect ratio
  },
  videoMultipleMedia: {
    height: CARD_HEIGHT,
    // No width or aspectRatio - width will be determined by video's natural aspect ratio
    alignSelf: 'flex-start',
  },
  imagePreserveAspect: {
    width: CARD_WIDTH,
    // No height or aspectRatio constraint - height determined by image's natural aspect ratio
  },
  imageMultipleMedia: {
    height: CARD_HEIGHT,
    // No width or aspectRatio - width will be determined by image's natural aspect ratio
    alignSelf: 'flex-start',
  },
});

export default PostAttachmentMedia;
