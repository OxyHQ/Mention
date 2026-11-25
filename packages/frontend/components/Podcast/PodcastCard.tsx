import { clamp } from '@oxy.so/utils/text';
import { memo, useCallback, useMemo, type ReactNode } from 'react';
import { isHostOf } from '@/utils/isHostOf';
import { Pressable, StyleSheet, View, type ViewStyle, type DimensionValue } from 'react-native';
import { Image } from 'expo-image';
import { RiRadioLine } from '@oxy.so/bloom/icons/RiRadioLine';
import { RiSpotifyFill } from '@oxy.so/bloom/icons/RiSpotifyFill';
import { RiYoutubeFill } from '@oxy.so/bloom/icons/RiYoutubeFill';
import { useTranslation } from 'react-i18next';
import { RiAppleFill } from '@oxy.so/bloom/icons/RiAppleFill';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import type { PostPodcastEpisode } from '@mention/shared-types/post';
import { openExternalLink } from '@/utils/openExternalLink';
import { SINGLE_MEDIA_MAX_HEIGHT } from '@/utils/composeUtils';
import { useArtworkAccent } from './useArtworkAccent';

import {
  Card,
  Embed,
  HStack,
  Icon,
  RawText,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';

type PodcastCardVariant = 'full' | 'card' | 'video';

interface PodcastCardProps {
  title: string;
  author?: string;
  artworkUrl?: string;
  /**
   * Opens the show in Syra on tap. Present for rendered posts and pinned profile
   * media (denormalized server-side). The compose attachment has no show URL yet,
   * so it omits this and supplies `onPress` to re-open the picker instead.
   */
  showUrl?: string;
  /**
   * `'full'` — the full-width profile card (square artwork + title + PODCAST +
   * author, on the muted surface).
   * `'card'` — the post attachment: artwork on the left, title, PODCAST and the
   * provider on a background taken from the artwork, with a save button.
   * `'video'` — the post attachment for an episode with a video rendition: the
   * video on top, and the show strip (small artwork, episode title, show,
   * provider, save) below it on the same artwork-colored background.
   *
   * `'video'` without a `video` slot renders as `'card'`.
   */
  variant?: PodcastCardVariant;
  episode?: PostPodcastEpisode;
  /** Card background; derived from the artwork when absent. */
  accentColor?: string;
  /** Rendered width of the attachment variants. Defaults to 320 (card) / 100% (video). */
  width?: DimensionValue;
  /**
   * Fixed height, when the card shares a row whose items all take one height.
   * The plain card fills it with its content centred (the artwork never grows);
   * the `'video'` variant gives the video whatever the strip below does not.
   */
  height?: number;
  /**
   * The save button, as a slot. The card stays presentational — no Syra query,
   * no video decoder — so the compose preview and the profile card never load
   * either; the post attachment (`PostPodcastAttachment`) supplies both.
   */
  saveButton?: ReactNode;
  /** The episode's video surface, filling the top of the `'video'` variant. */
  video?: ReactNode;
  /** Overrides the default tap behavior (open show). Compose passes the picker opener. */
  onPress?: () => void;
  /** Owner edit affordance (full variant only) — pencil tap + long-press. */
  onEdit?: () => void;
  isOwnProfile?: boolean;
}

/** Provider glyph and fallback-mic tint — icons take a colour prop, not a class. */
const WHITE_MUTED = 'rgba(255,255,255,0.72)';
const appColors = defineTokens({
  color: {
    WHITE_MUTED,
    white15: 'rgba(255,255,255,0.15)',
    white55: 'rgba(255,255,255,0.55)',
    hairline: '#fff3',
  },
});
const podcastTokens = defineTokens({
  space: { saveButton: 34 },
  iconSize: { cardMic: 38, stripMic: 19 },
  // The card title's 19px line over its 15pt size (a leading is a ratio of the size).
  leading: { cardTitle: 19 / 15 },
});
/** The video variant's show strip is at least 12 padding + 48 artwork + 12 padding (more when its text runs longer). */
const STRIP_MIN_HEIGHT = 72;

type Provider = { label: string; glyph: 'spotify' | 'apple' | 'youtube' | 'syra' };

/** Where the show opens, as the card names it — read off the show URL's host. */
function providerFor(showUrl?: string): Provider | null {
  if (!showUrl) return null;
  let host: string;
  try {
    host = new URL(showUrl).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  if (isHostOf(host, 'spotify.com')) return { label: 'Spotify', glyph: 'spotify' };
  if (host === 'podcasts.apple.com') return { label: 'Podcasts', glyph: 'apple' };
  if (isHostOf(host, 'youtube.com') || host === 'youtu.be')
    return { label: 'YouTube', glyph: 'youtube' };
  if (isHostOf(host, 'syra.fm')) return { label: 'Syra', glyph: 'syra' };
  return null;
}

const providerRow = (provider: Provider) =>
  HStack(
    Icon(
      provider.glyph === 'spotify'
        ? RiSpotifyFill
        : provider.glyph === 'apple'
          ? RiAppleFill
          : provider.glyph === 'youtube'
            ? RiYoutubeFill
            : RiRadioLine,
    )
      .size('13')
      .foreground(appColors.color.WHITE_MUTED),
    RawText(provider.label).foreground('white/70').font('sm').weight('semibold').lines(1),
  )
    .align('center')
    .spacing('xs');

/**
 * Show artwork in the two sizes a card uses: `card` (96px, the plain card) and
 * `strip` (48px, under a video). Fixed per size, never scaled with the card.
 */
const artwork = (uri: string | undefined, size: 'card' | 'strip') => {
  const card = size === 'card';
  const side = card ? '96' : '48';
  const corner = card ? '10' : 'lg';
  return uri
    ? VStack(
        Embed(<Image source={{ uri }} style={styles.fill} contentFit="cover" transition={120} />),
        // Hairline so a cover the colour of the card still reads as its own square.
        VStack()
          .position({ top: 'none', right: 'none', bottom: 'none', left: 'none' })
          .frame({ width: side, height: side })
          .border(appColors.color.hairline, 'thin')
          .corner(corner)
          .allowsHitTesting(false),
      )
        .frame({ width: side, height: side })
        .corner(corner)
        .clipped()
    : VStack(
        Icon(RiMic2Line)
          .size(card ? podcastTokens.iconSize.cardMic : podcastTokens.iconSize.stripMic)
          .foreground(appColors.color.WHITE_MUTED),
      )
        .frame({ width: side, height: side })
        .background(appColors.color.white15)
        .corner(corner)
        .align('center')
        .justify('center');
};

/**
 * Shared, router-agnostic podcast card. Opens the show (`showUrl`) — or runs an
 * `onPress` override — across the profile card (`variant="full"`), the compose
 * attachment and the rendered-post attachment (`"card"` / `"video"`).
 *
 * The runtime styles are what is computed as it renders — the width and shared
 * row height a parent hands down, the artwork-derived background, and a video's
 * ratio.
 */
export const PodcastCard = memo(function PodcastCard({
  title,
  author,
  artworkUrl,
  showUrl,
  variant = 'card',
  episode,
  accentColor,
  width,
  height,
  saveButton,
  video,
  onPress,
  onEdit,
  isOwnProfile = false,
}: PodcastCardProps) {
  const { t } = useTranslation();
  const accent = useArtworkAccent(variant === 'full' ? undefined : artworkUrl, accentColor, title);
  const provider = useMemo(() => providerFor(showUrl), [showUrl]);

  const openShow = useCallback(() => {
    if (!showUrl) return;
    openExternalLink(showUrl);
  }, [showUrl]);

  const handlePress = onPress ?? (showUrl ? openShow : undefined);

  if (variant === 'full') {
    // The press (tap to open, long-press to edit) stays a `Pressable`, since
    // `Card` has no long-press; the surface inside it is Bloom's `Card`, painted
    // the muted fill (`contrast50`) this profile card has always sat on.
    return (
      <Pressable
        style={cardStyles.full}
        onPress={handlePress}
        onLongPress={isOwnProfile ? onEdit : undefined}
        accessibilityRole="button"
        accessibilityLabel={t('profile.media.openInSyra')}
      >
        {toElement(
          Card(
            artworkUrl
              ? VStack(
                  Embed(
                    <Image
                      source={{ uri: artworkUrl }}
                      style={styles.fill}
                      contentFit="cover"
                      transition={120}
                    />,
                  ),
                )
                  .frame({ width: '56', height: '56' })
                  .corner('md')
                  .clipped()
              : VStack(Icon(RiMic2Line).size('lg').foreground('muted'))
                  .frame({ width: '56', height: '56' })
                  .background('card')
                  .corner('md')
                  .align('center')
                  .justify('center'),
            VStack(
              RawText(title).foreground('foreground').font('md').weight('bold').lines(2),
              HStack(
                RawText(t('profile.media.podcastLabel'))
                  .foreground('muted')
                  .font('11')
                  .weight('semibold')
                  .textCase('uppercase')
                  .tracking('wide'),
                Embed(
                  author ? (
                    <>
                      {toElement(RawText('·').foreground('muted').font('11'))}
                      {toElement(
                        RawText(author).foreground('muted').font('sm').shrink('normal').lines(1),
                      )}
                    </>
                  ) : null,
                ),
              )
                .align('center')
                .spacing('6')
                .margin('top', '2xs'),
            )
              .flex('1')
              .shrink('normal'),
            isOwnProfile
              ? VStack(Icon(RiEditLine).size('sm').foreground('muted'))
                  .padding('xs')
                  .onPress(onEdit)
                  .role('button')
                  .label(t('profile.media.edit'))
                  .hitSlop('md')
              : Icon(RiExternalLinkLine).size('sm').foreground('muted'),
          )
            .style('plain')
            .radius('lg')
            .axis('horizontal')
            .align('center')
            .spacing('md')
            .padding('md')
            .background('mutedFill'),
        )}
      </Pressable>
    );
  }

  if (variant === 'video' && video) {
    const ratio = episode?.width && episode?.height ? episode.width / episode.height : 16 / 9;
    // Portrait video would make the card taller than the feed row can hold;
    // landscape wider than 16:9 leaves a sliver. Threads crops to the same band.
    const clampedRatio = clamp(ratio, 4 / 5, 16 / 9);
    return (
      <View style={[cardStyles.video, { width: width ?? '100%', height, backgroundColor: accent }]}>
        <View
          // In a row the video takes whatever the strip below does not: the
          // strip's height depends on its text, so a guessed height clips it.
          // Alone it follows its ratio, capped so the card never towers (the
          // video is `cover`, so the cap crops).
          style={[
            cardStyles.videoFrame,
            height !== undefined
              ? cardStyles.videoFrameInRow
              : {
                  aspectRatio: clampedRatio,
                  maxHeight: SINGLE_MEDIA_MAX_HEIGHT - STRIP_MIN_HEIGHT,
                },
          ]}
        >
          {video}
        </View>
        {toElement(
          HStack(
            HStack(
              artwork(artworkUrl, 'strip'),
              VStack(
                RawText(episode?.title ?? title)
                  .foreground('white')
                  .font('md')
                  .weight('bold')
                  .lines(1),
                RawText(episode ? title : author)
                  .foreground('white/70')
                  .font('14')
                  .lines(1),
                provider ? providerRow(provider) : null,
              )
                .flex('1')
                .shrink('normal')
                .spacing('1'),
            )
              .flex('1')
              .align('center')
              .spacing('md')
              .onPress(handlePress)
              .disabled(!handlePress)
              .role('button')
              .label(t('profile.media.openInSyra')),
            Embed(saveButton),
          )
            .padding('all', 'md')
            .align('start')
            .spacing('md'),
        )}
      </View>
    );
  }

  // The save button is a SIBLING of the card's pressable, never a child: on web
  // a Pressable renders a <button>-like element, and a button inside a button
  // is invalid DOM that also swallows the inner press.
  return (
    <View
      // Takes the row's shared height like every other item; the artwork stays
      // 96px and centres in it, so a podcast looks the same whatever sits
      // beside it.
      style={[cardStyles.card, { width: width ?? 320, height, backgroundColor: accent }]}
    >
      {toElement(
        HStack(
          artwork(artworkUrl, 'card'),
          VStack(
            RawText(episode?.title ?? title)
              .foreground('white')
              .font('md')
              .weight('bold')
              .leading(podcastTokens.leading.cardTitle)
              .lines(2),
            RawText(episode ? title : t('profile.media.podcastLabel'))
              .foreground(appColors.color.white55)
              .font('11')
              .weight('semibold')
              .textCase('uppercase')
              .tracking('wide')
              .lines(1),
            provider
              ? providerRow(provider).when(Boolean(saveButton), (v) =>
                  v.margin('right', podcastTokens.space.saveButton),
                )
              : null,
          )
            .padding('vertical', '2xs')
            .flex('1')
            .shrink('normal')
            .justify('center')
            .spacing('3'),
        )
          .padding('all', '10')
          .flex('1')
          .align('center')
          .spacing('md')
          .onPress(handlePress)
          .disabled(!handlePress)
          .role('button')
          .label(t('profile.media.openInSyra')),
      )}
      {saveButton
        ? toElement(VStack(Embed(saveButton)).position({ right: '10', bottom: '10' }))
        : null}
    </View>
  );
});

// expo-image takes no className here, so its fill is the one static StyleSheet.
const styles = StyleSheet.create({
  fill: { width: '100%', height: '100%' },
});

// The cards' outer boxes stay views: each takes a style handed down at runtime (the
// row's width and height, the artwork's accent) and the video's ratio. These draw
// what their classes drew.
const cardStyles = {
  full: { marginBottom: 12 },
  video: { alignSelf: 'flex-start', borderRadius: 16, overflow: 'hidden' },
  videoFrame: { width: '100%', backgroundColor: '#000000' },
  videoFrameInRow: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', minHeight: 0 },
  card: { alignSelf: 'flex-start', flexDirection: 'row', borderRadius: 16, overflow: 'hidden' },
} satisfies Record<string, ViewStyle>;
