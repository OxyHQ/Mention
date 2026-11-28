import type React from 'react';
import { View, StyleSheet } from 'react-native';
import type { HydratedPostSummary } from '@mention/shared-types';
import type { OpenPostPanel } from '@/components/Post/postEngagementContext';

export type NestedPostRenderer = (
  post: HydratedPostSummary,
  nestingDepth: number,
  openPostEngagement?: OpenPostPanel | null,
) => React.ReactNode;

interface PostAttachmentNestedProps {
  nestedPost: HydratedPostSummary;
  nestingDepth: number;
  renderPost: NestedPostRenderer;
  openPostEngagement?: OpenPostPanel | null;
}

const PostAttachmentNested: React.FC<PostAttachmentNestedProps> = ({
  nestedPost,
  nestingDepth,
  renderPost,
  openPostEngagement,
}) => {
  return (
    <View style={styles.nestedContainer}>
      {renderPost(nestedPost, nestingDepth + 1, openPostEngagement)}
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
