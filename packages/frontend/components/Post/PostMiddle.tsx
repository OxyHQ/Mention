import React, { useRef, useMemo, useCallback, useEffect } from 'react';
import { Image, ScrollView, StyleSheet, View, Text, GestureResponderEvent, Dimensions, Pressable } from 'react-native';
import PollCard from './PollCard';
import { useOxy } from '@oxyhq/services';
// Dynamic import to break circular dependency: PostItem -> PostMiddle -> PostItem
// Using a function to lazily require PostItem only when needed
let PostItemComponent: React.ComponentType<any> | null = null;
const getPostItem = () => {
  if (!PostItemComponent) {
    PostItemComponent = require('../Feed/PostItem').default;
  }
  return PostItemComponent;
};
import { useTheme } from '@/hooks/useTheme';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useRouter } from 'expo-router';

interface MediaObj { id: string; type: 'image' | 'video' }
interface Props {
  media?: MediaObj[];
  nestedPost?: any; // original (repost) or parent (reply)
  leftOffset?: number; // negative margin-left to offset avatar space
  pollId?: string;
  pollData?: any; // Direct poll data from content.poll
  nestingDepth?: number; // Track nesting depth to prevent infinite nesting
  postId?: string; // Post ID for navigation to videos screen
}

// Video item component to properly use the hook
const VideoItem: React.FC<{ 
  src: string; 
  containerStyle?: any; 
  borderColor: string; 
  backgroundColor: string;
  postId?: string;
  onPress?: () => void;
  hasSingleMedia?: boolean; // If true, remove max height constraint
  hasMultipleMedia?: boolean; // If true, use fixed height with width determined by aspect ratio
}> = ({ src, containerStyle, borderColor, backgroundColor, postId, onPress, hasSingleMedia, hasMultipleMedia }) => {
  const player = useVideoPlayer(src, (player) => {
    if (player) {
      player.loop = true;
      player.muted = true;
    }
  });

  // Autoplay video when component mounts
  useEffect(() => {
    if (player) {
      const playVideo = async () => {
        try {
          await player.play();
        } catch (error) {
          // Autoplay may be blocked - silently handle
        }
      };
      playVideo();
    }
    return () => {
      if (player) {
        try {
          player.pause();
        } catch (error) {
          // Silently handle pause errors
        }
      }
    };
  }, [player]);

  return (
    <Pressable 
      onPress={onPress}
      style={({ pressed }) => [
        { opacity: pressed ? 0.9 : 1 },
        hasMultipleMedia && { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' }
      ]}
    >
      <View style={[
        styles.itemContainer,
        { borderColor, backgroundColor },
        hasMultipleMedia && { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' }
      ]}>
        <VideoView
          player={player}
          style={hasSingleMedia ? styles.videoPreserveAspect : styles.videoMultipleMedia}
          contentFit="contain"
          nativeControls={false}
          allowsFullscreen={false}
          allowsPictureInPicture={false}
          pointerEvents="none"
        />
      </View>
    </Pressable>
  );
};

const PostMiddle: React.FC<Props> = ({ media, nestedPost, leftOffset = 0, pollId, pollData, nestingDepth = 0, postId }) => {
  const theme = useTheme();
  const router = useRouter();
  
  // Check if post has exactly one video (for navigation to videos screen)
  const videoMedia = media?.filter(m => m.type === 'video') || [];
  const hasSingleVideo = videoMedia.length === 1 && (media?.length || 0) === 1;
  // Check if there's only one media item (excluding polls and nested posts)
  const hasSingleMedia = (media?.length || 0) === 1 && !pollId && !pollData && !nestedPost;
  // Check if there are multiple media items
  const hasMultipleMedia = (media?.length || 0) > 1;
  
  const handleVideoPress = useCallback(() => {
    if (postId && hasSingleVideo) {
      router.push(`/videos?postId=${postId}`);
    }
  }, [postId, hasSingleVideo, router]);
  // Prevent infinite nesting (max 2 levels deep)
  const MAX_NESTING_DEPTH = 2;
  const screenWidth = Dimensions.get('window').width;
  const [scrollViewWidth, setScrollViewWidth] = React.useState(screenWidth);
  type Item = { type: "nested" } | { type: "image"; src: string } | { type: "video"; src: string } | { type: "poll" };
  const items: Item[] = [];
  const { oxyServices } = useOxy();

  if (pollId || pollData) items.push({ type: "poll" });
  // Only add nested post if we haven't exceeded max nesting depth
  if (nestedPost && nestingDepth < MAX_NESTING_DEPTH) items.push({ type: "nested" });

  (media || []).forEach((m) => {
    if (m && m.id && m.type) {
      const uri = oxyServices?.getFileDownloadUrl ? oxyServices.getFileDownloadUrl(m.id) : m.id;
      items.push({ type: m.type, src: uri });
    }
  });

  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);

  const onTouchStart = (e: GestureResponderEvent) => {
    const t = e.nativeEvent.touches && e.nativeEvent.touches[0];
    if (t) {
      startX.current = t.pageX;
      startY.current = t.pageY;
    }
  };

  const onMoveShouldSetResponderCapture = (e: GestureResponderEvent) => {
    const t = e.nativeEvent.touches && e.nativeEvent.touches[0];
    if (!t || startX.current === null || startY.current === null) return false;
    const dx = Math.abs(t.pageX - startX.current);
    const dy = Math.abs(t.pageY - startY.current);
    // capture when the gesture is predominantly horizontal
    return dx > dy && dx > 5;
  };

  if (items.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // allow nested scrolling on Android and improve horizontal gesture handling on native
      nestedScrollEnabled={true}
      directionalLockEnabled={true}
      // capture horizontal gestures when drag is mostly horizontal so this scrollview wins
      onTouchStart={onTouchStart}
      onMoveShouldSetResponderCapture={onMoveShouldSetResponderCapture}
      // try to capture responder at start so parent pressables/lists don't steal the gesture
      onStartShouldSetResponderCapture={() => true}
      onStartShouldSetResponder={() => true}
      onLayout={(e) => setScrollViewWidth(e.nativeEvent.layout.width)}
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={[styles.scroller, { backgroundColor: theme.colors.background }, leftOffset ? { paddingLeft: leftOffset } : null]}
    >
      {items.map((item, idx) => {
        if (item.type === 'poll') {
          return (
            <View key={`poll-${idx}`} style={[styles.itemContainer, styles.pollWrapper, { borderColor: theme.colors.border }]}>
              {pollId ? (
                // Use interactive PollCard when we have a pollId
                <PollCard pollId={pollId as string} />
              ) : pollData ? (
                // Fallback to simple display if we only have poll data without ID
                <View style={[styles.pollContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                  <Text style={[styles.pollQuestion, { color: theme.colors.text }]}>{pollData.question}</Text>
                  {pollData.options?.map((option: string, optIdx: number) => (
                    <View key={optIdx} style={[styles.pollOption, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}>
                      <Text style={[styles.pollOptionText, { color: theme.colors.text }]}>{option}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          );
        }
        if (item.type === 'nested') {
          // Render PostItem with dynamic require to break circular dependency
          // Pass nesting depth to prevent infinite recursion
          // Use the measured ScrollView width minus the applied paddings
          const scrollerPaddingRight = 12; // from styles.scroller
          const scrollerPaddingLeft = Math.abs(leftOffset); // applied via contentContainerStyle
          const nestedWidth = scrollViewWidth - scrollerPaddingLeft - scrollerPaddingRight;
          const PostItem = getPostItem();
          return (
            <View key={`nested-${idx}`} style={[styles.nestedContainer, { width: nestedWidth }]}>
              <PostItem post={nestedPost} isNested={true} nestingDepth={nestingDepth + 1} />
            </View>
          );
        }
        if (item.type === 'video') {
          return (
            <VideoItem
              key={`video-${idx}`}
              src={item.src}
              containerStyle={[]}
              borderColor={theme.colors.border}
              backgroundColor={theme.colors.backgroundSecondary}
              postId={postId}
              onPress={hasSingleVideo ? handleVideoPress : undefined}
              hasSingleMedia={hasSingleMedia}
              hasMultipleMedia={hasMultipleMedia}
            />
          );
        }
        // For multiple media, calculate aspect ratio dynamically
        const ImageWithAspectRatio = hasMultipleMedia ? (() => {
          const ImageWithRatio: React.FC<{ src: string }> = ({ src }) => {
            const [aspectRatio, setAspectRatio] = React.useState<number | undefined>(undefined);
            
            React.useEffect(() => {
              Image.getSize(
                src,
                (width, height) => {
                  if (width > 0 && height > 0) {
                    setAspectRatio(width / height);
                  }
                },
                () => {
                  // On error, use default
                  setAspectRatio(4 / 3);
                }
              );
            }, [src]);

            return (
              <View style={[
                styles.itemContainer,
                { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary },
                { width: undefined, maxWidth: undefined, alignSelf: 'flex-start' }
              ]}>
                <Image
                  source={{ uri: src }}
                  style={[
                    styles.imageMultipleMedia,
                    aspectRatio !== undefined ? { aspectRatio } : undefined
                  ]}
                  resizeMode="contain"
                />
              </View>
            );
          };
          return <ImageWithRatio key={`img-${idx}`} src={(item as any).src} />;
        })() : (
          <View style={[
            styles.itemContainer,
            { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }
          ]}>
            <Image
              key={`img-${idx}`}
              source={{ uri: (item as any).src }}
              style={styles.imagePreserveAspect}
              resizeMode="contain"
            />
          </View>
        );

        return ImageWithAspectRatio;
      })}
    </ScrollView>
  );
};

export default PostMiddle;

const CARD_WIDTH = 280;
const CARD_HEIGHT = 180;

const styles = StyleSheet.create({
  scroller: {
    paddingRight: 12,
    gap: 12,
  },
  itemContainer: {
    borderWidth: 1,
    borderRadius: 15,
    overflow: 'hidden', // Ensure content respects border radius
  },
  pollWrapper: {
    width: CARD_WIDTH,
  },
  mediaImage: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  },
  mediaContainer: {
    width: CARD_WIDTH,
    alignSelf: 'flex-start',
    // Container wraps content - height determined by media's natural aspect ratio (single media)
  },
  mediaContainerMultiple: {
    height: CARD_HEIGHT,
    alignSelf: 'flex-start',
    // Container has fixed height - width will be determined by content (media's natural aspect ratio)
    flexShrink: 0,
  },
  video: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  },
  videoPreserveAspect: {
    width: CARD_WIDTH,
    aspectRatio: 1, // Square default - contentFit="contain" will preserve video's natural ratio within this
  },
  videoMultipleMedia: {
    height: CARD_HEIGHT,
    // No width or aspectRatio - width will be determined by video's natural aspect ratio with contentFit="contain"
    alignSelf: 'flex-start',
  },
  imagePreserveAspect: {
    width: CARD_WIDTH,
    aspectRatio: 1, // Square default - resizeMode="contain" will preserve image's natural ratio within this
  },
  imageMultipleMedia: {
    height: CARD_HEIGHT,
    // No width or aspectRatio - width will be determined by image's natural aspect ratio with resizeMode="contain"
    alignSelf: 'flex-start',
  },
  pollContainer: {
    padding: 16,
    borderRadius: 15,
  },
  pollQuestion: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  pollOption: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  pollOptionText: {
    fontSize: 14,
  },
  nestedContainer: {
    // Width is set dynamically to fill available space
  },
});
