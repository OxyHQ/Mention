import React from 'react';
import { View, StyleSheet } from 'react-native';
import type { HydratedPostSummary } from '@mention/shared-types';

// PostItem's `post` prop. Typed structurally here (the concrete `PostEntity`
// alias is local to PostItem) to keep the dynamic require below typed without a
// circular import.
type NestedPostItemProps = { post: HydratedPostSummary; isNested?: boolean; nestingDepth?: number };

// Dynamic import to break circular dependency: PostItem -> PostAttachmentsRow -> PostItem
let PostItemComponent: React.ComponentType<NestedPostItemProps> | null = null;
const getPostItem = () => {
  if (!PostItemComponent) {
    PostItemComponent = require('../../Feed/PostItem').default;
  }
  return PostItemComponent;
};

interface PostAttachmentNestedProps {
  nestedPost: HydratedPostSummary;
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

