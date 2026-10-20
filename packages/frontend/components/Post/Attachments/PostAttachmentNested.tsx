import type React from 'react';
import { View, StyleSheet } from 'react-native';
import type { HydratedPostSummary } from '@mention/shared-types';

export type NestedPostRenderer = (
  post: HydratedPostSummary,
  nestingDepth: number,
) => React.ReactNode;

interface PostAttachmentNestedProps {
  nestedPost: HydratedPostSummary;
  nestingDepth: number;
  renderPost: NestedPostRenderer;
}

const PostAttachmentNested: React.FC<PostAttachmentNestedProps> = ({
  nestedPost,
  nestingDepth,
  renderPost,
}) => {
  return <View style={styles.nestedContainer}>{renderPost(nestedPost, nestingDepth + 1)}</View>;
};

const styles = StyleSheet.create({
  // Fills the row; the quote card's own attachments size against it by layout.
  nestedContainer: {
    width: '100%',
  },
});

export default PostAttachmentNested;
