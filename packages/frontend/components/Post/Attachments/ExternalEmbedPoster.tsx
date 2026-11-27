import { useMemo, useState } from 'react';
import { benchMark } from '@/lib/bench';
import { StyleSheet } from 'react-native';
import { BloomImage } from '@oxy.so/bloom/image';
import { RiPlayFill } from '@oxy.so/bloom/icons/RiPlayFill';
import { proxyExternalUrl } from '@/utils/mediaUrls';
import { feedLinkCover } from '@/utils/feedImages';

import { Icon, SpinnerIcon, VStack, defineTokens, toElement, Embed } from '@oxy.so/bloom-language';
const posterTokens = defineTokens({
  color: { white: 'white', scrim: '#0000004d' },
  iconSize: { spinner: 36 },
});

interface ExternalEmbedPosterProps {
  /** Thumbnail (link-preview image) shown behind the play button. */
  thumb?: string;
  /** Whether the underlying player surface has been mounted. */
  active: boolean;
  /** Whether the active player is still loading (show a spinner over the thumb). */
  loading: boolean;
  /** Fired when the (inactive) play button is pressed. */
  onPressPlay: () => void;
}

/**
 * Shared overlay for an external embed: the thumbnail, a dim scrim, and a center
 * play button (or a loading spinner once the player is mounting). Returns
 * nothing once the player is active and finished loading, handing the frame to
 * the platform-specific player surface (iframe / WebView). Platform-neutral —
 * used by both `ExternalEmbedPlayer.web.tsx` and `.native.tsx`.
 */
export function ExternalEmbedPoster({
  thumb,
  active,
  loading,
  onPressPlay,
}: ExternalEmbedPosterProps) {
  // A remote link-preview thumbnail can 404 or fail to load even through the
  // proxy — fall back to the plain dim scrim + play button rather than showing a
  // broken image. Reset the error state when the thumb URL changes.
  // Reset during render rather than in an effect, so a new thumb never renders
  // one committed frame of the previous one's failure.
  const [thumbErrored, setThumbErrored] = useState(false);
  const [erroredThumb, setErroredThumb] = useState(thumb);
  if (erroredThumb !== thumb) {
    setErroredThumb(thumb);
    setThumbErrored(false);
  }

  // The link card's cover (`feedLinkCover`: one sized URL on a device, every
  // rendition on the web), through the proxy.
  const thumbSources = useMemo(() => {
    const cover = feedLinkCover(thumb);
    if (typeof cover === 'string') return proxyExternalUrl(cover);
    return cover?.map((source) => ({ ...source, uri: proxyExternalUrl(source.uri) }));
  }, [thumb]);

  if (active && !loading) return null;

  // The frame and its scrim are pinned by their four edges (the classes drew
  // React Native's `inset`).
  return toElement(
    VStack(
      Embed(
        thumb && !thumbErrored ? (
          <BloomImage
            source={thumbSources}
            recyclingKey={thumb}
            cachePolicy="memory-disk"
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            onLoad={() => benchMark('feed-image')}
            onError={() => setThumbErrored(true)}
          />
        ) : null,
      ),
      // Black at 30%, as NativeWind wrote `bg-black/30` (an 8-bit alpha).
      VStack()
        .position({ top: 'none', right: 'none', bottom: 'none', left: 'none' })
        .background(posterTokens.color.scrim),
      // React Native's Pressable: while the player loads it has no press and
      // stays in the focus order, as it was; the language takes a press-less
      // stack out of it.
      VStack(
        active
          ? SpinnerIcon().size(posterTokens.iconSize.spinner).tint('white')
          : VStack(Icon(RiPlayFill).size('2xl').foreground(posterTokens.color.white))
              .frame({ height: '64', width: '64' })
              .background('black/60')
              .corner('infinite')
              .align('center')
              .justify('center'),
      )
        .align('center')
        .justify('center')
        .flex('1')
        .onPress(active ? undefined : onPressPlay)
        .role('button'),
    )
      .position({ top: 'none', right: 'none', bottom: 'none', left: 'none' })
      .allowsHitTesting('children'),
  );
}
