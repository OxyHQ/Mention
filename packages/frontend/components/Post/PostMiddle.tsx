import React from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import PostItem from '../Feed/PostItem';
import PollCard from './PollCard';
import { colors } from '@/styles/colors';

interface Props {
  media?: string[];
  nestedPost?: any; // original (repost) or parent (reply)
  leftOffset?: number; // negative margin-left to offset avatar space
  pollId?: string;
}

const PostMiddle: React.FC<Props> = ({ media, nestedPost, leftOffset = 0, pollId }) => {
  type Item = { type: "nested" } | { type: "image"; src: string } | { type: "poll" };
  const items: Item[] = [];

  if (pollId) items.push({ type: "poll" });
  if (nestedPost) items.push({ type: "nested" });
  (media || []).forEach((src) => items.push({ type: "image", src }));

  if (items.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.scroller, leftOffset ? { paddingLeft: leftOffset } : null]}
    >
      {items.map((item, idx) => {
        if (item.type === 'poll') {
          return (
            <View key={`poll-${idx}`} style={styles.itemContainer}>
              <PollCard pollId={pollId as string} />
            </View>
          );
        }
        if (item.type === 'nested') {
          return <PostItem key={`nested-${idx}`} post={nestedPost} isNested={true} />
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
    flex: 1,
  },
  itemContainer: {
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 10,
  },
  mediaImage: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    backgroundColor: '#EFEFEF',
  },
});
