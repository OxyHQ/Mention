import type React from 'react';
import { useMemo } from 'react';
import { type ViewStyle, Platform } from 'react-native';
import { LinkPreviewCard } from '@oxy.so/bloom/link-preview';
import { feedLinkCover } from '@/utils/feedImages';
import { openExternalLink } from '@/utils/openExternalLink';

interface PostAttachmentLinkProps {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  /** The byline, e.g. `documentByline(document)`. */
  author?: string;
  /** Its preview is still on its way: the card is drawn at the size it will have. */
  pending?: boolean;
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
  author,
  pending = false,
  coverFill = false,
  className = 'w-[280px]',
  style,
}) => {
  const cover = useMemo(() => feedLinkCover(image), [image]);
  return (
    <LinkPreviewCard
      url={url}
      title={title}
      description={description}
      image={cover}
      siteName={siteName}
      author={author}
      pending={pending}
      onPress={() => openExternalLink(url)}
      coverFill={coverFill}
      className={className}
      style={[webGrabCursorStyle, style]}
    />
  );
};

export default PostAttachmentLink;
