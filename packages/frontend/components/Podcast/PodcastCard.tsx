import React, { memo, useCallback, useMemo, type ReactNode } from 'react';
import { isHostOf } from '@/utils/isHostOf';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import Svg, { Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import type { PostPodcastEpisode } from '@mention/shared-types/post';
import { cn } from '@/lib/utils';
import { openExternalLink } from '@/utils/openExternalLink';
import { HIT_SLOP_MD } from '@/styles/hitSlop';
import { useArtworkAccent } from './useArtworkAccent';

export type PodcastCardVariant = 'full' | 'card' | 'video';

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
  width?: number;
  /**
   * Fixed height, when the card shares a row whose items all take one height.
   * The card centers its content in it; the video variant gives the video
   * whatever the strip below it does not use.
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

const CARD_RADIUS = 16;
const CARD_ARTWORK = 96;
const STRIP_ARTWORK = 48;
/** Height of the video variant's show strip: 12 padding + 48 artwork + 12 padding. */
const STRIP_HEIGHT = 72;
const WHITE_MUTED = 'rgba(255,255,255,0.72)';
const WHITE_FAINT = 'rgba(255,255,255,0.56)';

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
  if (isHostOf(host, 'youtube.com') || host === 'youtu.be') return { label: 'YouTube', glyph: 'youtube' };
  if (isHostOf(host, 'syra.fm')) return { label: 'Syra', glyph: 'syra' };
  return null;
}

const SpotifyGlyph = ({ size, color }: { size: number; color: string }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Path
      fill={color}
      d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.52 17.34c-.24.36-.66.48-1.02.24-2.82-1.74-6.36-2.1-10.56-1.14-.42.12-.78-.18-.9-.54-.12-.42.18-.78.54-.9 4.56-1.02 8.52-.6 11.64 1.32.42.18.48.66.3 1.02zm1.44-3.3c-.3.42-.84.6-1.26.3-3.24-1.98-8.16-2.58-11.94-1.38-.48.12-1.02-.12-1.14-.6-.12-.48.12-1.02.6-1.14C9.6 9.9 15 10.56 18.72 12.84c.36.18.54.78.24 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.3c-.6.18-1.2-.18-1.38-.72-.18-.6.18-1.2.72-1.38 4.26-1.26 11.28-1.02 15.72 1.62.54.3.72 1.02.42 1.56-.3.42-1.02.6-1.56.3z"
    />
  </Svg>
);

const ProviderRow = ({ provider }: { provider: Provider }) => (
  <View className="flex-row items-center" style={{ gap: 4 }}>
    {provider.glyph === 'spotify' ? (
      <SpotifyGlyph size={13} color={WHITE_MUTED} />
    ) : (
      <Ionicons
        name={provider.glyph === 'apple' ? 'logo-apple' : provider.glyph === 'youtube' ? 'logo-youtube' : 'radio'}
        size={13}
        color={WHITE_MUTED}
      />
    )}
    <Text style={{ color: WHITE_MUTED }} className="text-[13px] font-semibold" numberOfLines={1}>
      {provider.label}
    </Text>
  </View>
);

const Artwork = ({ uri, size, radius }: { uri?: string; size: number; radius: number }) =>
  uri ? (
    <View style={{ width: size, height: size, borderRadius: radius, overflow: 'hidden' }}>
      <Image source={{ uri }} style={{ width: size, height: size }} contentFit="cover" transition={120} />
      {/* Hairline so a cover the color of the card still reads as its own square. */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: radius,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: 'rgba(255,255,255,0.18)',
        }}
      />
    </View>
  ) : (
    <View
      style={{ width: size, height: size, borderRadius: radius, backgroundColor: 'rgba(255,255,255,0.14)' }}
      className="items-center justify-center"
    >
      <Ionicons name="mic" size={size * 0.4} color={WHITE_MUTED} />
    </View>
  );

/**
 * Shared, router-agnostic podcast card. Opens the show (`showUrl`) — or runs an
 * `onPress` override — across the profile card (`variant="full"`), the compose
 * attachment and the rendered-post attachment (`"card"` / `"video"`).
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
  // In a fixed-height row the artwork grows with the card (Threads' card is
  // mostly cover), capped so the title column keeps room for two lines.
  const cardArtwork = height !== undefined ? Math.min(height - 20, 150) : CARD_ARTWORK;

  if (variant === 'full') {
    return (
      <Pressable
        className={cn('flex-row items-center gap-3 mb-3 rounded-2xl bg-muted p-3', className)}
        style={style}
        onPress={handlePress}
        onLongPress={isOwnProfile ? onEdit : undefined}
        accessibilityRole="button"
        accessibilityLabel={t('profile.media.openInSyra')}
      >
        {artworkUrl ? (
          <Image
            source={{ uri: artworkUrl }}
            style={{ width: 56, height: 56, borderRadius: 12 }}
            contentFit="cover"
            transition={120}
          />
        ) : (
          <View
            className="rounded-xl bg-background items-center justify-center"
            style={{ width: 56, height: 56 }}
          >
            <Ionicons name="mic-outline" size={24} color={colors.textSecondary} />
          </View>
        )}

        <View className="flex-1 shrink">
          <Text className="text-foreground text-[15px] font-bold" numberOfLines={2}>
            {title}
          </Text>
          <View className="flex-row items-center gap-1.5 mt-0.5">
            <Text className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
              {t('profile.media.podcastLabel')}
            </Text>
            {author ? (
              <>
                <Text className="text-muted-foreground text-[11px]">·</Text>
                <Text className="text-muted-foreground text-[13px] shrink" numberOfLines={1}>
                  {author}
                </Text>
              </>
            ) : null}
          </View>
        </View>

        {isOwnProfile ? (
          <Pressable
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel={t('profile.media.edit')}
            hitSlop={HIT_SLOP_MD}
            className="p-1"
          >
            <Ionicons name="pencil-outline" size={16} color={colors.textSecondary} />
          </Pressable>
        ) : (
          <Ionicons name="open-outline" size={16} color={colors.textSecondary} />
        )}
      </Pressable>
    );
  }

  if (variant === 'video' && video) {
    const ratio =
      episode?.width && episode?.height ? episode.width / episode.height : 16 / 9;
    // Portrait video would make the card taller than the feed row can hold;
    // landscape wider than 16:9 leaves a sliver. Threads crops to the same band.
    const clampedRatio = Math.min(Math.max(ratio, 4 / 5), 16 / 9);
    return (
      <View
        className={className}
        style={[
          { width: width ?? '100%', height, alignSelf: 'flex-start', borderRadius: CARD_RADIUS, overflow: 'hidden', backgroundColor: accent },
          style,
        ]}
      >
        <View
          style={
            height !== undefined
              ? { width: '100%', height: Math.max(height - STRIP_HEIGHT, 0), backgroundColor: '#000' }
              : { width: '100%', aspectRatio: clampedRatio, backgroundColor: '#000' }
          }
        >
          {video}
        </View>
        <View className="flex-row items-start" style={{ padding: 12, gap: 12 }}>
          <Pressable
            onPress={handlePress}
            disabled={!handlePress}
            accessibilityRole="button"
            accessibilityLabel={t('profile.media.openInSyra')}
            className="flex-1 flex-row items-center"
            style={{ gap: 12 }}
          >
            <Artwork uri={artworkUrl} size={STRIP_ARTWORK} radius={8} />
            <View className="flex-1 shrink" style={{ gap: 1 }}>
              <Text className="text-white text-[15px] font-bold" numberOfLines={1}>
                {episode?.title ?? title}
              </Text>
              <Text style={{ color: WHITE_MUTED }} className="text-[14px]" numberOfLines={1}>
                {episode ? title : author}
              </Text>
              {provider ? <ProviderRow provider={provider} /> : null}
            </View>
          </Pressable>
          {saveButton}
        </View>
      </View>
    );
  }

  // The save button is a SIBLING of the card's pressable, never a child: on web
  // a Pressable renders a <button>-like element, and a button inside a button
  // is invalid DOM that also swallows the inner press.
  return (
    <View
      className={className}
      style={[
        {
          width: width ?? 320,
          height,
          // Never stretch to a taller neighbour in the attachments carousel.
          alignSelf: 'flex-start',
          borderRadius: CARD_RADIUS,
          overflow: 'hidden',
          backgroundColor: accent,
          flexDirection: 'row',
        },
        style,
      ]}
    >
      <Pressable
        onPress={handlePress}
        disabled={!handlePress}
        accessibilityRole="button"
        accessibilityLabel={t('profile.media.openInSyra')}
        className="flex-1 flex-row items-center"
        style={{ padding: 10, gap: 12 }}
      >
        <Artwork uri={artworkUrl} size={cardArtwork} radius={10} />
        <View className="flex-1 shrink justify-center" style={{ paddingVertical: 2, gap: 3 }}>
          <Text className="text-white text-[15px] font-bold leading-[19px]" numberOfLines={2}>
            {episode?.title ?? title}
          </Text>
          <Text
            style={{ color: WHITE_FAINT }}
            className="text-[11px] font-semibold uppercase tracking-wide"
            numberOfLines={1}
          >
            {episode ? title : t('profile.media.podcastLabel')}
          </Text>
          {provider ? <ProviderRow provider={provider} /> : null}
        </View>
      </Pressable>
      {saveButton ? (
        <View style={{ alignSelf: 'flex-end', padding: 10, paddingLeft: 0 }}>
          {saveButton}
        </View>
      ) : null}
    </View>
  );
});
