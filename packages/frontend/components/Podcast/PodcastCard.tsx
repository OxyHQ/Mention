import { clamp } from '@oxy.so/utils/text';
import { tokens } from '@oxy.so/bloom/styles';
import { memo, useCallback, useMemo, type ReactNode } from 'react';
import { isHostOf } from '@/utils/isHostOf';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
  type DimensionValue,
} from 'react-native';
import { Image } from 'expo-image';
import { RiRadioLine } from '@oxy.so/bloom/icons/RiRadioLine';
import { RiSpotifyFill } from '@oxy.so/bloom/icons/RiSpotifyFill';
import { RiYoutubeFill } from '@oxy.so/bloom/icons/RiYoutubeFill';
import { useTranslation } from 'react-i18next';
import { Card } from '@oxy.so/bloom/card';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiAppleFill } from '@oxy.so/bloom/icons/RiAppleFill';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiExternalLinkLine } from '@oxy.so/bloom/icons/RiExternalLinkLine';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import type { PostPodcastEpisode } from '@mention/shared-types/post';
import { cn } from '@/lib/utils';
import { openExternalLink } from '@/utils/openExternalLink';
import { SINGLE_MEDIA_MAX_HEIGHT } from '@/utils/composeUtils';
import { useArtworkAccent } from './useArtworkAccent';

import {
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
  className?: string;
  style?: StyleProp<ViewStyle>;
}

/** Provider glyph and fallback-mic tint — icons take a colour prop, not a class. */
const WHITE_MUTED = 'rgba(255,255,255,0.72)';
const appColors = defineTokens({ color: { WHITE_MUTED } });
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

const ProviderRow = ({ provider, className }: { provider: Provider; className?: string }) => (
  <View className={cn('flex-row items-center gap-1', className)}>
    {provider.glyph === 'spotify'
      ? toElement(Icon(RiSpotifyFill).size('13').foreground(appColors.color.WHITE_MUTED))
      : provider.glyph === 'apple'
        ? toElement(Icon(RiAppleFill).size('13').foreground(appColors.color.WHITE_MUTED))
        : provider.glyph === 'youtube'
          ? toElement(Icon(RiYoutubeFill).size('13').foreground(appColors.color.WHITE_MUTED))
          : toElement(Icon(RiRadioLine).size('13').foreground(appColors.color.WHITE_MUTED))}
    {toElement(
      RawText(provider.label).foreground('white/70').font('sm').weight('semibold').lines(1),
    )}
  </View>
);

/**
 * Show artwork in the two sizes a card uses: `card` (96px, the plain card) and
 * `strip` (48px, under a video). Fixed per size, never scaled with the card.
 */
const Artwork = ({ uri, size }: { uri?: string; size: 'card' | 'strip' }) => {
  const box = size === 'card' ? 'size-24 rounded-[10px]' : 'size-12 rounded-lg';
  return uri ? (
    <View className={cn(box, 'overflow-hidden')}>
      <Image source={{ uri }} style={styles.fill} contentFit="cover" transition={120} />
      {/* Hairline so a cover the colour of the card still reads as its own square. */}
      <View pointerEvents="none" className={cn(box, 'absolute inset-0 border border-white/20')} />
    </View>
  ) : (
    <View className={cn(box, 'bg-white/15 items-center justify-center')}>
      <RiMic2Line
        width={size === 'card' ? 38 : 19}
        height={size === 'card' ? 38 : 19}
        fill={WHITE_MUTED}
      />
    </View>
  );
};

/**
 * Shared, router-agnostic podcast card. Opens the show (`showUrl`) — or runs an
 * `onPress` override — across the profile card (`variant="full"`), the compose
 * attachment and the rendered-post attachment (`"card"` / `"video"`).
 *
 * Styling is NativeWind; `style` carries only what is computed at runtime —
 * the width and shared row height a parent hands down, the artwork-derived
 * background, and a video's ratio.
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
  className,
  style,
}: PodcastCardProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
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
        className={cn('mb-3', className)}
        style={style}
        onPress={handlePress}
        onLongPress={isOwnProfile ? onEdit : undefined}
        accessibilityRole="button"
        accessibilityLabel={t('profile.media.openInSyra')}
      >
        <Card
          appearance="plain"
          radius="radius-16"
          className="flex-row items-center gap-3 p-3"
          style={{ backgroundColor: colors.contrast50 }}
        >
          {artworkUrl
            ? toElement(
                VStack(
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
                  .clipped(),
              )
            : toElement(
                VStack(Icon(RiMic2Line).size('lg').foreground('muted'))
                  .frame({ width: '56', height: '56' })
                  .background('card')
                  .corner('md')
                  .align('center')
                  .justify('center'),
              )}

          {toElement(
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
          )}

          {isOwnProfile ? (
            <Pressable
              onPress={onEdit}
              accessibilityRole="button"
              accessibilityLabel={t('profile.media.edit')}
              hitSlop={tokens.hitSlop.md}
              className="p-1"
            >
              {toElement(Icon(RiEditLine).size('sm').foreground('muted'))}
            </Pressable>
          ) : (
            toElement(Icon(RiExternalLinkLine).size('sm').foreground('muted'))
          )}
        </Card>
      </Pressable>
    );
  }

  if (variant === 'video' && video) {
    const ratio = episode?.width && episode?.height ? episode.width / episode.height : 16 / 9;
    // Portrait video would make the card taller than the feed row can hold;
    // landscape wider than 16:9 leaves a sliver. Threads crops to the same band.
    const clampedRatio = clamp(ratio, 4 / 5, 16 / 9);
    return (
      <View
        className={cn('self-start rounded-2xl overflow-hidden', className)}
        style={[{ width: width ?? '100%', height, backgroundColor: accent }, style]}
      >
        <View
          // In a row the video takes whatever the strip below does not: the
          // strip's height depends on its text, so a guessed height clips it.
          // Alone it follows its ratio, capped so the card never towers (the
          // video is `cover`, so the cap crops).
          className={cn('w-full bg-black', height !== undefined && 'flex-1 min-h-0')}
          style={
            height !== undefined
              ? undefined
              : { aspectRatio: clampedRatio, maxHeight: SINGLE_MEDIA_MAX_HEIGHT - STRIP_MIN_HEIGHT }
          }
        >
          {video}
        </View>
        {toElement(
          HStack(
            HStack(
              Embed(<Artwork uri={artworkUrl} size="strip" />),
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
                Embed(provider ? <ProviderRow provider={provider} /> : null),
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
      className={cn('self-start flex-row rounded-2xl overflow-hidden', className)}
      style={[{ width: width ?? 320, height, backgroundColor: accent }, style]}
    >
      {toElement(
        HStack(
          Embed(<Artwork uri={artworkUrl} size="card" />),
          VStack(
            Embed(
              <Text className="text-white text-[15px] font-bold leading-[19px]" numberOfLines={2}>
                {episode?.title ?? title}
              </Text>,
            ),
            Embed(
              <Text
                className="text-white/55 text-[11px] font-semibold uppercase tracking-wide"
                numberOfLines={1}
              >
                {episode ? title : t('profile.media.podcastLabel')}
              </Text>,
            ),
            Embed(
              provider ? (
                <ProviderRow provider={provider} className={saveButton ? 'mr-[34px]' : undefined} />
              ) : null,
            ),
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
