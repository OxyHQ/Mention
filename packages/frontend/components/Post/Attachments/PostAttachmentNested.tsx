import React from 'react';
import { View, StyleSheet } from 'react-native';

// Dynamic import to break circular dependency: PostItem -> PostAttachmentsRow -> PostItem
let PostItemComponent: React.ComponentType<any> | null = null;
const getPostItem = () => {
  if (!PostItemComponent) {
    PostItemComponent = require('../../Feed/PostItem').default;
  }
  return PostItemComponent;
};

interface PostAttachmentNestedProps {
  nestedPost: any;
  nestingDepth: number;
  width: number;
  /**
   * Drop the nested card's own top margin so it sits flush under the outer header.
   * Set when this card is the first content block under a text-less header (e.g. a
   * boost) — the outer block already supplies the hug gap, so the card's own
   * `nestedPostContainer` top margin would otherwise double the gap.
   */
  hugHeader?: boolean;
}

const PostAttachmentNested: React.FC<PostAttachmentNestedProps> = ({
  nestedPost,
  nestingDepth,
  width,
  hugHeader = false,
}) => {
  const PostItem = getPostItem();
  if (!PostItem) return null;

  return (
    <View style={[styles.nestedContainer, { width }]}>
      <PostItem
        post={nestedPost}
        isNested={true}
        nestingDepth={nestingDepth + 1}
        style={hugHeader ? styles.hugHeader : undefined}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  nestedContainer: {
    // Width is set dynamically to fill available space
  },
  // Override the nested PostItem's `nestedPostContainer` top margin so the card
  // hugs the outer header when it's the first content block under a text-less post.
  hugHeader: {
    marginTop: 0,
  },
});

export default PostAttachmentNested;

