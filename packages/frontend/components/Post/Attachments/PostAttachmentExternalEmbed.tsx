import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';
import { BloomImage } from '@oxy.so/bloom/image';
import { AspectRatio } from '@oxy.so/bloom/aspect-ratio';
import { useDialogControl } from '@oxy.so/bloom/dialog';
import { parseEmbedPlayerFromUrl, canEmbed } from '@/utils/embedPlayer';
import { proxyExternalUrl } from '@/utils/mediaUrls';
import { useExternalEmbedsStore } from '@/stores/externalEmbedsStore';
import { ExternalEmbedPlayer } from './ExternalEmbedPlayer';
import { EmbedConsentDialog } from './EmbedConsentDialog';
import PostAttachmentLink from './PostAttachmentLink';

import {
  type Child,
  Embed,
  RawText,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';

interface PostAttachmentExternalEmbedProps {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  author?: string;
  /** The link's preview is still on its way: hold the space its thumbnail and title will take. */
  pending?: boolean;
}

/** The embed's card: the row's full width, the card fill and its outline. */
function embedCard(...children: Child[]) {
  return VStack(...children)
    .frame({ width: 'full' })
    .background('card')
    .border('border', 'thin')
    .corner('lg')
    .clipped();
}

const linkCardStyle = StyleSheet.create({ fill: { width: '100%' } }).fill;

/**
 * The details block holds two lines of title (`md` at `easy` leading) whether
 * the title is one line, two, or still on its way, so the card does not change
 * height when the preview lands.
 */
const embedTokens = defineTokens({ space: { titleReserve: 2 * 15 * 1.375 } });

const GIF_ASPECT_RATIO = 16 / 9;

/**
 * Wraps a link attachment in an inline external media player when the URL maps
 * to a supported provider AND the viewer hasn't hidden that provider. Mirrors
 * Bluesky's ExternalEmbed: an unsupported URL (or a `'hide'` preference) renders
 * the static {@link PostAttachmentLink} card; a GIF renders inline (proxied,
 * never phoning home); anything else renders the play-gated player with a
 * first-play consent prompt.
 */
const PostAttachmentExternalEmbed: React.FC<PostAttachmentExternalEmbedProps> = ({
  url,
  title,
  description,
  image,
  siteName,
  author,
  pending = false,
}) => {
  const params = useMemo(() => parseEmbedPlayerFromUrl(url), [url]);
  const pref = useExternalEmbedsStore((state) => (params ? state.prefs[params.source] : undefined));

  const [active, setActive] = useState(false);
  const consentControl = useDialogControl();

  const domain = useMemo(() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }, [url]);

  const onPressPlay = useCallback(() => {
    // No persisted choice yet → ask before loading anything external.
    if (pref === undefined) {
      consentControl.open();
      return;
    }
    setActive(true);
  }, [pref, consentControl]);

  const onAccept = useCallback(() => setActive(true), []);
  const onDeactivate = useCallback(() => setActive(false), []);

  // Unsupported provider or a hidden one → fall back to the static link card.
  if (!canEmbed(params, pref)) {
    return (
      <PostAttachmentLink
        url={url}
        title={title}
        description={description}
        image={image}
        siteName={siteName}
        author={author}
        pending={pending}
        style={linkCardStyle}
      />
    );
  }

  // GIFs render inline (proxied through our backend, so they never phone home).
  // `hideDetails` is set for GIFs, so no title/domain footer.
  if (params.isGif) {
    return toElement(
      embedCard(
        Embed(
          <AspectRatio ratio={GIF_ASPECT_RATIO} style={styles.gifWell}>
            <BloomImage
              source={{ uri: proxyExternalUrl(params.playerUri) }}
              recyclingKey={params.playerUri}
              cachePolicy="memory-disk"
              style={StyleSheet.absoluteFill}
              contentFit="contain"
            />
          </AspectRatio>,
        ),
      ),
    );
  }

  return toElement(
    embedCard(
      Embed(
        <EmbedConsentDialog control={consentControl} source={params.source} onAccept={onAccept} />,
      ),
      Embed(
        <ExternalEmbedPlayer
          params={params}
          thumb={image}
          expectsThumb={pending}
          active={active}
          onPressPlay={onPressPlay}
          onDeactivate={onDeactivate}
        />,
      ),
      params.hideDetails
        ? null
        : VStack(
            title || pending
              ? RawText(title ?? '')
                  .font('md')
                  .weight('semibold')
                  .leading('easy')
                  .foreground('foreground')
                  .lines(2)
                  .frame({ minHeight: embedTokens.space.titleReserve })
              : null,
            RawText(domain).font('xs').leading('16px').foreground('muted').lines(1),
          )
            .padding('horizontal', 'md')
            .padding('vertical', 'sm')
            .spacing('xs'),
    ),
  );
};

const styles = StyleSheet.create({
  gifWell: { overflow: 'hidden' },
});

export default PostAttachmentExternalEmbed;
