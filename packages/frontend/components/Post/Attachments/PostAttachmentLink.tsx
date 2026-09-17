import React from 'react';
import { ViewStyle, Platform } from 'react-native';
import { LinkPreviewCard } from '@oxy.so/bloom/link-preview';
import { openExternalLink } from '@/utils/openExternalLink';

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
  /** Card width; 280 when absent. A link alone in the row passes the row width. */
  width?: number;
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
  width = 280,
  style,
}) => {
  return (
    <LinkPreviewCard
      url={url}
      title={title}
      description={description}
      image={image}
      siteName={siteName}
      onPress={() => openExternalLink(url)}
      coverFill={constrainedHeight !== undefined}
      style={[{ width }, constrainedHeight !== undefined ? { height: constrainedHeight } : null, webGrabCursorStyle, style]}
    />
  );
};

export default PostAttachmentLink;
