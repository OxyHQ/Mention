import type React from 'react';
import { useMemo } from 'react';
import { type ViewStyle, Platform } from 'react-native';
import { LinkPreviewCard } from '@oxy.so/bloom/link-preview';
import { linkPreviewImageSources } from '@/utils/linkPreviewImage';
import { openExternalLink } from '@/utils/openExternalLink';

interface PostAttachmentLinkProps {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  /** The byline, e.g. `documentByline(document)`. */
  author?: string;
  /**
   * The card sits in the attachments carousel, whose `style` binds it to the
   * row's height: the cover image then flexes to fill it (`coverFill`) so the
   * link matches the other items. False when the link is alone, keeping the
   * card's intrinsic height.
   */
  coverFill?: boolean;
  /**
   * Layout over the card's own width: the full row alone, the card width and row
   * height in the carousel.
   */
  style?: ViewStyle;
}

const defaultWidthStyle: ViewStyle = { width: 280 };

const webGrabCursorStyle: ViewStyle | null =
  Platform.OS === 'web' ? ({ cursor: 'grab' } as unknown as ViewStyle) : null;

const PostAttachmentLink: React.FC<PostAttachmentLinkProps> = ({
  url,
  title,
  description,
  image,
  siteName,
  author,
  coverFill = false,
  style,
}) => {
  const imageSources = useMemo(() => linkPreviewImageSources(image), [image]);
  return (
    <LinkPreviewCard
      url={url}
      title={title}
      description={description}
      image={imageSources}
      siteName={siteName}
      author={author}
      onPress={() => openExternalLink(url)}
      coverFill={coverFill}
      style={[defaultWidthStyle, webGrabCursorStyle, style]}
    />
  );
};

export default PostAttachmentLink;
