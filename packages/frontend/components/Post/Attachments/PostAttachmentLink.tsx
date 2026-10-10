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
   * The card sits in the attachments carousel, whose `className` binds it to the
   * row's height: the cover image then flexes to fill it (`coverFill`) so the
   * link matches the other items. False when the link is alone, keeping the
   * card's intrinsic height.
   */
  coverFill?: boolean;
  /** Layout classes: `w-full` alone in the row, the card width and row height in the carousel. */
  className?: string;
  style?: ViewStyle;
}

const webGrabCursorStyle: ViewStyle | null =
  Platform.OS === 'web' ? ({ cursor: 'grab' } as unknown as ViewStyle) : null;

const PostAttachmentLink: React.FC<PostAttachmentLinkProps> = ({
  url,
  title,
  description,
  image,
  siteName,
  coverFill = false,
  className = 'w-[280px]',
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
      coverFill={coverFill}
      className={className}
      style={[webGrabCursorStyle, style]}
    />
  );
};

export default PostAttachmentLink;
