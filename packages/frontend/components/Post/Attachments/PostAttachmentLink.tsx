import React from 'react';
import { ViewStyle, Platform } from 'react-native';
import { LinkPreviewCard } from '@oxyhq/bloom/link-preview';

interface PostAttachmentLinkProps {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  /**
   * When set, the card is bound to this height and the cover image flexes to
   * fill it (`coverFill`) so the link matches the media row's item height when
   * it shares the horizontal attachment row. Left undefined when the link is
   * the sole attachment, keeping the card's intrinsic sizing.
   */
  constrainedHeight?: number;
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
  constrainedHeight,
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
      coverFill={constrainedHeight !== undefined}
      style={[constrainedHeight !== undefined ? { height: constrainedHeight } : null, webGrabCursorStyle, style]}
    />
  );
};

export default PostAttachmentLink;
