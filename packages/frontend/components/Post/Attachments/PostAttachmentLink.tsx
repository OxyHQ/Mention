import React from 'react';
import { View, StyleSheet, ViewStyle, Platform } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { LinkPreview } from '../../Compose/LinkPreview';

interface PostAttachmentLinkProps {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  style?: ViewStyle;
}

const webGrabCursorStyle: ViewStyle | null = Platform.OS === 'web'
  ? ({ cursor: 'grab' } as unknown as ViewStyle)
  : null;

const PostAttachmentLink: React.FC<PostAttachmentLinkProps> = ({
  url,
  title,
  description,
  image,
  siteName,
  style,
}) => {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.itemContainer,
        webGrabCursorStyle,
        styles.linkWrapper,
        { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary },
        style,
      ]}
    >
      <LinkPreview
        link={{
          url,
          title,
          description,
          image,
          siteName,
          fetchedAt: Date.now(),
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  itemContainer: {
    borderWidth: 1,
    borderRadius: 14,
    overflow: 'hidden',
  },
  linkWrapper: {
    width: 280,
  },
});

export default PostAttachmentLink;

