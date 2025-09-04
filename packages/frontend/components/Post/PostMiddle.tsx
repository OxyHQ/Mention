import React from 'react';
import { Image, ScrollView, StyleSheet } from 'react-native';
import PostItem from '../Feed/PostItem';

interface Props {
  media?: string[];
  nestedPost?: any; // original (repost) or parent (reply)
  leftOffset?: number; // negative margin-left to offset avatar space
}

const PostMiddle: React.FC<Props> = ({ media, nestedPost, leftOffset = 0 }) => {
  const items: Array<'nested' | { type: 'image'; src: string }> = [] as any;

  if (nestedPost) items.push('nested');
  (media || []).forEach((src) => items.push({ type: 'image', src } as any));

  if (items.length === 0) return null;

  return (
    <ScrollView
      style={leftOffset ? [{ marginLeft: -leftOffset, marginTop: 12, marginBottom: 12 }] as any : { marginTop: 12, marginBottom: 12 } as any}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.scroller, leftOffset ? { paddingLeft: leftOffset } : null]}
    >
      {items.map((item, idx) => {
        if (item === 'nested') {
          return (
            <PostItem key={`nested-${idx}`} post={nestedPost} isNested={true} />
          );
        }
        const image = item as { type: 'image'; src: string };
        return (
          <Image
            key={`img-${idx}`}
            source={{ uri: image.src }}
            style={styles.mediaImage}
            resizeMode="cover"
          />
        );
      })}
    </ScrollView>
  );
};

export default PostMiddle;

const styles = StyleSheet.create({
  scroller: {
    paddingRight: 8,
  },
});
