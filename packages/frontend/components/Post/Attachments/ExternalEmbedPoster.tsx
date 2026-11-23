import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { RiPlayFill } from '@oxy.so/bloom/icons/RiPlayFill';
import { proxyExternalUrl } from '@/utils/mediaUrls';
import { linkPreviewImageSources } from '@/utils/linkPreviewImage';

import {
  Icon,
  VStack,
  defineTokens,
  toElement,
  Embed,
  VStack as LVStack,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';
const posterTokens = defineTokens({ color: { white: 'white' } });

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

  // Every rendition goes through the proxy, so expo-image still picks the one
  // the poster's size needs.
  const thumbSources = useMemo(
    () =>
      linkPreviewImageSources(thumb)?.map((source) => ({
        ...source,
        uri: proxyExternalUrl(source.uri),
      })),
    [thumb],
  );

  if (active && !loading) return null;

  // The frame and its scrim are pinned with React Native's `inset`, as the
  // classes drew them; the language pins a view by its four edges instead.
  return LtoElement(
    LVStack(
      Embed(
        thumb && !thumbErrored ? (
          <Image
            source={thumbSources}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            onError={() => setThumbErrored(true)}
          />
        ) : null,
      ),
      Embed(<View style={styles.scrim} />),
      /* React Native's Pressable: while the player loads it has no press and
        stays in the focus order, as it was; the language takes a press-less
        stack out of it. */ Embed(
        <Pressable
          onPress={active ? undefined : onPressPlay}
          accessibilityRole="button"
          style={styles.play}
        >
          {active ? (
            <SpinnerIcon size={36} color="white" />
          ) : (
            toElement(
              VStack(Icon(RiPlayFill).size('2xl').foreground(posterTokens.color.white))
                .frame({ height: '64', width: '64' })
                .background('black/60')
                .corner('infinite')
                .align('center')
                .justify('center'),
            )
          )}
        </Pressable>,
      ),
    )
      .position({ top: 'none', right: 'none', bottom: 'none', left: 'none' })
      .allowsHitTesting('children'),
  );
}

const styles = StyleSheet.create({
  frame: { position: 'absolute', inset: 0 },
  // Black at 30%, as NativeWind wrote `bg-black/30` (an 8-bit alpha).
  scrim: { position: 'absolute', inset: 0, backgroundColor: '#0000004d' },
  // Tailwind's `flex-1 items-center justify-center`.
  play: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
