import React, { useRef, useMemo, useCallback } from 'react';
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
  containerStyle: any; 
  borderColor: string; 
  backgroundColor: string;
  postId?: string;
  onPress?: () => void;
}> = ({ src, containerStyle, borderColor, backgroundColor, postId, onPress }) => {
  const player = useVideoPlayer(src, (player) => {
    player.loop = false;
    player.muted = false;
  });

  return (
    <Pressable 
      onPress={onPress}
      style={({ pressed }) => [{ opacity: pressed ? 0.9 : 1 }]}
    >
      <View style={[containerStyle, { borderColor, backgroundColor }]}>
        <VideoView
          player={player}
          style={styles.video}
          contentFit="cover"
          nativeControls={true}
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
              containerStyle={[styles.mediaImage, styles.itemContainer]}
              borderColor={theme.colors.border}
              backgroundColor={theme.colors.backgroundSecondary}
              postId={postId}
              onPress={hasSingleVideo ? handleVideoPress : undefined}
            />
          );
        }
        return (
          <Image
            key={`img-${idx}`}
            source={{ uri: (item as any).src }}
            style={[styles.mediaImage, styles.itemContainer, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
            resizeMode="cover"
          />
        );
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
  video: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
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
