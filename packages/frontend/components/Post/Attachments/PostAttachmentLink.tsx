import React from 'react';
import { ViewStyle, Platform } from 'react-native';
import { LinkPreviewCard } from '@oxyhq/bloom/link-preview';

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
    <LinkPreviewCard
      url={url}
      title={title}
      description={description}
      image={image}
      siteName={siteName}
      className="w-[280px]"
      style={[webGrabCursorStyle, style]}
    />
  );
};

export default PostAttachmentLink;
