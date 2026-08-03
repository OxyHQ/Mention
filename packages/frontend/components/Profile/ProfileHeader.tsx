import React, { memo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import Animated, { useDerivedValue, useAnimatedStyle, interpolate, Extrapolation } from 'react-native-reanimated';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { ZoomableAvatar } from '@/components/ZoomableAvatar';
import { LiveAvatar } from '@/components/ui/LiveAvatar';
import { MEDIA_VARIANT_AVATAR_LG } from '@mention/shared-types/post';
import { useLiveUsers } from '@/hooks/useLiveUsers';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { Gear } from '@/assets/icons/gear-icon';
import { PresenceIndicator } from '@/components/PresenceIndicator';
import { FrostedIconButton } from '@oxyhq/bloom/frosted-icon-button';
import { usePoke } from './hooks/usePoke';
import { useFederatedFollowSync } from './hooks/useFederatedFollowSync';
import { LAYOUT } from './types';
import type { ProfileHeaderProps } from './types';

// Shrink the 90px header avatar toward these values as the profile scrolls. The
// same constants drive both the ZoomableAvatar (non-live) collapse and the live
// avatar's collapse wrapper so the two stay pixel-identical during scroll.
const PROFILE_AVATAR_COLLAPSE_MIN_SCALE = 0.45;
const PROFILE_AVATAR_COLLAPSE_TRANSLATE_Y = 16;

/**
 * A PERSON's profile header: a 90px avatar overlapping the banner on the left,
 * the poke + follow controls on the right, and — on the viewer's own profile —
 * edit/analytics/settings instead.
 *
 * Person-only, and every part of it says so. The avatar collapses on scroll
 * because it overlaps a banner; the poke is addressed to somebody who can
 * receive one; the self view exists because a person can be signed in as
 * themselves. A channel satisfies none of those, and gets `ChannelHeader`.
 */
// Static header actions hoisted to stable module-level refs: FrostedIconButton is
// memo'd, so fresh inline handlers/icon elements each render would defeat the memo.
const goInsights = () => router.push('/insights');
const goSettings = () => router.push('/settings');
const ANALYTICS_ICON = <AnalyticsIcon size={20} className="text-foreground" />;
const SETTINGS_ICON = <Gear size={20} className="text-foreground" />;

export const ProfileHeader = memo(function ProfileHeader({
  username,
  avatarUri,
  isOwnProfile,
  currentUsername,
  profileId,
  isFederated,
  actorUri,
  isFollowing: initialIsFollowing,
  FollowButtonComponent,
}: ProfileHeaderProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const canPoke = !isFederated;
  const { poked, loading: pokeLoading, toggle: togglePoke } = usePoke(profileId, isOwnProfile || Boolean(isFederated));
  useFederatedFollowSync(profileId, isFederated, actorUri);

  // Normalized 0 → 1 collapse driver for the avatar shrink, derived on the UI
  // thread from the shared scroll offset (fed by both the native ScrollView and
  // the web window-scroll listener via LayoutScrollContext). Maps the first
  // HEADER_HEIGHT_EXPANDED px of scroll to the full shrink; clamped past that.
  const { scrollPosition } = useLayoutScroll();
  const avatarCollapseProgress = useDerivedValue(() =>
    interpolate(
      scrollPosition.value,
      [0, LAYOUT.HEADER_HEIGHT_EXPANDED],
      [0, 1],
      Extrapolation.CLAMP,
    ),
  );

  // When the profile owner is live, swap the zoom-to-fullscreen avatar for the
  // live-badged one (tap joins the room). The collapse-on-scroll shrink is
  // preserved by wrapping it in an animated view that mirrors ZoomableAvatar's
  // transform, so live and non-live headers behave identically while scrolling.
  const { isLive } = useLiveUsers();
  const isProfileLive = isLive(profileId);
  const liveAvatarCollapseStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: interpolate(avatarCollapseProgress.value, [0, 1], [1, PROFILE_AVATAR_COLLAPSE_MIN_SCALE], Extrapolation.CLAMP) },
      { translateY: interpolate(avatarCollapseProgress.value, [0, 1], [0, PROFILE_AVATAR_COLLAPSE_TRANSLATE_Y], Extrapolation.CLAMP) },
    ],
  }));

  return (
    <View className="flex-row justify-between items-end mb-2.5" style={{ marginTop: -45 }}>
      <View className="relative">
        {isProfileLive ? (
          <Animated.View
            className="border-[3px] border-background bg-secondary rounded-full"
            style={liveAvatarCollapseStyle}
          >
            <LiveAvatar userId={profileId} source={avatarUri ?? undefined} size={90} variant={MEDIA_VARIANT_AVATAR_LG} />
          </Animated.View>
        ) : (
          <ZoomableAvatar
            source={avatarUri}
            size={90}
            className="border-[3px] border-background bg-secondary"
            style={{ width: 90, height: 90, borderRadius: 45 }}
            imageStyle={{}}
            collapseProgress={avatarCollapseProgress}
            collapseMinScale={PROFILE_AVATAR_COLLAPSE_MIN_SCALE}
            collapseTranslateY={PROFILE_AVATAR_COLLAPSE_TRANSLATE_Y}
          />
        )}
        {!isOwnProfile && profileId && (
          <PresenceIndicator
            userId={profileId}
            size="medium"
            style={{ position: 'absolute', bottom: 4, right: 4 }}
          />
        )}
      </View>
      <View className="flex-row items-center">
        {isOwnProfile && currentUsername === username ? (
          <View className="flex-row items-center gap-3">
            <TouchableOpacity
              className="border border-border bg-background rounded-full px-6 py-2"
              onPress={() => router.push('/edit-profile')}
              accessibilityRole="button"
              accessibilityLabel={t('profile.editProfile')}
            >
              <Text className="text-foreground text-sm font-semibold">{t('profile.editProfile')}</Text>
            </TouchableOpacity>
            <FrostedIconButton
              size="md"
              onPress={goInsights}
              accessibilityLabel="Analytics"
              icon={ANALYTICS_ICON}
            />
            <FrostedIconButton
              size="md"
              onPress={goSettings}
              accessibilityLabel="Settings"
              icon={SETTINGS_ICON}
            />
          </View>
        ) : profileId ? (
          <View className="flex-row items-center gap-3">
            {canPoke && (
              <FrostedIconButton
                size="md"
                onPress={togglePoke}
                disabled={pokeLoading}
                active={poked}
                accessibilityLabel={poked ? 'Unpoke' : 'Poke'}
                icon={
                  <Ionicons
                    name={poked ? 'hand-right' : 'hand-right-outline'}
                    size={18}
                    color={poked ? theme.colors.primaryForeground : theme.colors.text}
                  />
                }
              />
            )}
            {/* Seed from the profile DTO's authoritative viewer relationship so
                the button paints correctly on first render. When the DTO omits it,
                the app-root follow-store seed covers followed users. */}
            <FollowButtonComponent
              userId={profileId}
              initiallyFollowing={initialIsFollowing}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
});
