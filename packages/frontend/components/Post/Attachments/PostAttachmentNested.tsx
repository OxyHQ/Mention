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
}

const PostAttachmentNested: React.FC<PostAttachmentNestedProps> = ({
  nestedPost,
  nestingDepth,
  width,
}) => {
  const PostItem = getPostItem();
  if (!PostItem) return null;

  return (
    <View style={[styles.nestedContainer, { width }]}>
      <PostItem post={nestedPost} isNested={true} nestingDepth={nestingDepth + 1} />
    </View>
  );
};

const styles = StyleSheet.create({
  nestedContainer: {
    // Width is set dynamically to fill available space
  },
});

export default PostAttachmentNested;

