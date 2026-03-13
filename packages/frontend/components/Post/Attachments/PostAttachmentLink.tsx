import React from 'react';
import { View, ViewStyle, Platform } from 'react-native';
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
  return (
    <View
      className="border border-border bg-secondary rounded-[14px] overflow-hidden w-[280px]"
      style={[webGrabCursorStyle, style]}
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

export default PostAttachmentLink;
