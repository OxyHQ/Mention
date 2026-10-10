import type React from 'react';
import { lazy, Suspense } from 'react';
import { View, StyleSheet } from 'react-native';
import type { HydratedPostSummary } from '@mention/shared-types';

// PostItem's `post` prop. Typed structurally here because the concrete
// `PostEntity` alias is local to PostItem.
type NestedPostItemProps = {
  post: HydratedPostSummary;
  isNested?: boolean;
  nestingDepth?: number;
};

// Lazy loading breaks PostItem -> PostAttachmentsRow -> PostItem without a
// CommonJS runtime require.
const PostItem = lazy(() => import('../../Feed/PostItem')) as React.LazyExoticComponent<
  React.ComponentType<NestedPostItemProps>
>;

interface PostAttachmentNestedProps {
  nestedPost: HydratedPostSummary;
  nestingDepth: number;
}

const PostAttachmentNested: React.FC<PostAttachmentNestedProps> = ({
  nestedPost,
  nestingDepth,
}) => {
  return (
    <View style={styles.nestedContainer}>
      <Suspense fallback={null}>
        <PostItem post={nestedPost} isNested={true} nestingDepth={nestingDepth + 1} />
      </Suspense>
    </View>
  );
};

const styles = StyleSheet.create({
  // Fills the row; the quote card's own attachments size against it by layout.
  nestedContainer: {
    width: '100%',
  },
});

export default PostAttachmentNested;
