import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useDialogControl } from '@oxyhq/bloom/dialog';
import { parseEmbedPlayerFromUrl } from '@/utils/embedPlayer';
import { proxyExternalUrl } from '@/utils/imageUrlCache';
import { useExternalEmbedsStore } from '@/stores/externalEmbedsStore';
import { ExternalEmbedPlayer } from './ExternalEmbedPlayer';
import { EmbedConsentDialog } from './EmbedConsentDialog';
import PostAttachmentLink from './PostAttachmentLink';

interface PostAttachmentExternalEmbedProps {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  /** Available render width for the embed (treated as full-width primary media). */
  width: number;
  style?: ViewStyle;
}

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
  width,
  style,
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
  if (!params || pref === 'hide') {
    return (
      <PostAttachmentLink
        url={url}
        title={title}
        description={description}
        image={image}
        siteName={siteName}
        style={style}
      />
    );
  }

  // GIFs render inline (proxied through our backend, so they never phone home).
  // `hideDetails` is set for GIFs, so no title/domain footer.
  if (params.isGif) {
    return (
      <View style={[{ width }, style]} className="overflow-hidden rounded-2xl border border-border bg-card">
        <View style={{ aspectRatio: GIF_ASPECT_RATIO }} className="w-full overflow-hidden">
          <Image
            source={{ uri: proxyExternalUrl(params.playerUri) }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
          />
        </View>
      </View>
    );
  }

  return (
    <View style={[{ width }, style]} className="overflow-hidden rounded-2xl border border-border bg-card">
      <EmbedConsentDialog control={consentControl} source={params.source} onAccept={onAccept} />

      <ExternalEmbedPlayer
        params={params}
        thumb={image}
        width={width}
        active={active}
        onPressPlay={onPressPlay}
        onDeactivate={onDeactivate}
      />

      {!params.hideDetails ? (
        <View className="gap-1 px-3 py-2">
          {title ? (
            <Text numberOfLines={2} className="text-[15px] font-semibold leading-snug text-foreground">
              {title}
            </Text>
          ) : null}
          <Text numberOfLines={1} className="text-xs text-muted-foreground">
            {domain}
          </Text>
        </View>
      ) : null}
    </View>
  );
};

export default PostAttachmentExternalEmbed;
