// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
  coverFill = false,
  className = 'w-[280px]',
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
      className={className}
      style={[webGrabCursorStyle, style]}
    />
  );
};

export default PostAttachmentLink;
