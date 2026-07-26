import React, { lazy, Suspense } from 'react';
import { View, StyleSheet } from 'react-native';
import type { HydratedPostSummary } from '@mention/shared-types';

// PostItem's `post` prop. Typed structurally here because the concrete
// `PostEntity` alias is local to PostItem.
type NestedPostItemProps = { post: HydratedPostSummary; isNested?: boolean; nestingDepth?: number };

// Lazy loading breaks PostItem -> PostAttachmentsRow -> PostItem without a
// CommonJS runtime require.
const PostItem = lazy(() => import('../../Feed/PostItem')) as React.LazyExoticComponent<
  React.ComponentType<NestedPostItemProps>
>;

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
  return (
    <View style={[styles.nestedContainer, { width }]}>
      <Suspense fallback={null}>
        <PostItem post={nestedPost} isNested={true} nestingDepth={nestingDepth + 1} />
      </Suspense>
    </View>
  );
};

const styles = StyleSheet.create({
  nestedContainer: {
    // Width is set dynamically to fill available space
  },
});

export default PostAttachmentNested;
