import React, { useRef, useMemo } from 'react';
import { Image, ScrollView, StyleSheet, View, Text, GestureResponderEvent, Dimensions } from 'react-native';
import PollCard from './PollCard';
import { colors } from '@/styles/colors';
import { useOxy } from '@oxyhq/services';
import PostItem from '../Feed/PostItem';
import { useTheme } from '@/hooks/useTheme';

interface MediaObj { id: string; type: 'image' | 'video' }
interface Props {
  media?: MediaObj[];
  nestedPost?: any; // original (repost) or parent (reply)
  leftOffset?: number; // negative margin-left to offset avatar space
  pollId?: string;
  pollData?: any; // Direct poll data from content.poll
  nestingDepth?: number; // Track nesting depth to prevent infinite nesting
}

const PostMiddle: React.FC<Props> = ({ media, nestedPost, leftOffset = 0, pollId, pollData, nestingDepth = 0 }) => {
  const theme = useTheme();
  // Prevent infinite nesting (max 2 levels deep)
  const MAX_NESTING_DEPTH = 2;
  const screenWidth = Dimensions.get('window').width;
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
      contentContainerStyle={[styles.scroller, leftOffset ? { paddingLeft: leftOffset } : null]}
    >
      {items.map((item, idx) => {
        if (item.type === 'poll') {
          return (
            <View key={`poll-${idx}`} style={styles.itemContainer}>
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
          // Render PostItem directly for instant loading (no lazy loading)
          // Pass nesting depth to prevent infinite recursion
          // Calculate width: screen width minus left offset and right padding
          const nestedWidth = screenWidth - leftOffset - 32;
          return (
            <View key={`nested-${idx}`} style={[styles.nestedContainer, styles.itemContainer, { width: nestedWidth }]}>
              <PostItem post={nestedPost} isNested={true} nestingDepth={nestingDepth + 1} />
            </View>
          );
        }
        return (
          <Image
            key={`img-${idx}`}
            source={{ uri: (item as any).src }}
            style={[styles.mediaImage, styles.itemContainer]}
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
    borderColor: "#EFF3F4",
    borderRadius: 15,
  },
  mediaImage: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    backgroundColor: "#1a1a1a",
  },
  pollContainer: {
    padding: 16,
    backgroundColor: "#FFFFFF",
    borderRadius: 15,
  },
  pollQuestion: {
    fontSize: 16,
    fontWeight: 'bold',
    color: "#000000",
    marginBottom: 12,
  },
  pollOption: {
    padding: 12,
    backgroundColor: "#F7F9F9",
    borderRadius: 8,
    marginBottom: 8,
  },
  pollOptionText: {
    fontSize: 14,
    color: "#000000",
  },
  nestedContainer: {
    maxHeight: CARD_HEIGHT * 1.5,
    backgroundColor: "#FFFFFF",
    overflow: 'hidden',
  },
});
