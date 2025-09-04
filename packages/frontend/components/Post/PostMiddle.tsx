import React from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import PostItem from '../Feed/PostItem';

interface Props {
  media?: string[];
  nestedPost?: any; // original (repost) or parent (reply)
  leftOffset?: number; // negative margin-left to offset avatar space
}

const PostMiddle: React.FC<Props> = ({ media, nestedPost, leftOffset = 0 }) => {
  type Item = { type: "nested" } | { type: "image"; src: string };
  const items: Item[] = [];

  if (nestedPost) items.push({ type: "nested" });
  (media || []).forEach((src) => items.push({ type: "image", src }));

  if (items.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.scroller, leftOffset ? { paddingLeft: leftOffset } : null]}
    >
      {items.map((item, idx) =>
        item.type === "nested" ? (
          <PostItem key={idx} post={nestedPost} isNested={true} />
        ) : (
          <Image
            key={idx}
            source={{ uri: item.src }}
            style={[styles.mediaImage, styles.itemContainer]}
            resizeMode="cover"
          />
        )
      )}
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
    borderWidth: 5,
    borderColor: '#000',
  },
  mediaImage: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    borderRadius: 10,
    backgroundColor: '#EFEFEF',
  },
});
