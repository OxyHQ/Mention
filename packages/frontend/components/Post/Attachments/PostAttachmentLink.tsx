import type React from 'react';
import { useMemo } from 'react';
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
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
   * The card sits in the attachments carousel, whose cell style binds it to the
   * row's height: the cover image then flexes to fill it (`coverFill`) so the
   * link matches the other items. False when the link is alone, keeping the
   * card's intrinsic height.
   */
  coverFill?: boolean;
  /** The cell's size: its full width alone in the row, the card width and row height in the carousel; 280pt wide by default. */
  style?: StyleProp<ViewStyle>;
}

const styles = StyleSheet.create({
  card: { width: 280 },
});

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
  style = styles.card,
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
      style={[webGrabCursorStyle, style]}
    />
  );
};

export default PostAttachmentLink;
