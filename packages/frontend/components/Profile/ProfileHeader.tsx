import React, { memo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import FontAwesome5 from '@expo/vector-icons/FontAwesome5';
import Animated, { useDerivedValue, useAnimatedStyle, interpolate, Extrapolation } from 'react-native-reanimated';
import { cn } from '@/lib/utils';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { ZoomableAvatar } from '@/components/ZoomableAvatar';
import { LiveAvatar } from '@/components/ui/LiveAvatar';
import { MEDIA_VARIANT_VIDEO_POSTER } from '@mention/shared-types';
import { useLiveUsers } from '@/hooks/useLiveUsers';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { Gear } from '@/assets/icons/gear-icon';
import { PrivateBadge } from './PrivateBadge';
import { PresenceIndicator } from '@/components/PresenceIndicator';
import { usePoke } from './hooks/usePoke';
import { useFederatedFollowSync } from './hooks/useFederatedFollowSync';
import { useViewerFollowingSet } from '@/hooks/useViewerFollowing';
import { LAYOUT } from './types';
import type {
  FollowButtonComponent as FollowButtonComponentType,
  ProfileHeaderDefaultProps,
  ProfileHeaderMinimalistProps,
  UserNameComponent,
} from './types';

// Shrink the 90px header avatar toward these values as the profile scrolls. The
// same constants drive both the ZoomableAvatar (non-live) collapse and the live
// avatar's collapse wrapper so the two stay pixel-identical during scroll.
const PROFILE_AVATAR_COLLAPSE_MIN_SCALE = 0.45;
const PROFILE_AVATAR_COLLAPSE_TRANSLATE_Y = 16;

/**
 * Default profile header with avatar on left
 */
export const ProfileHeaderDefault = memo(function ProfileHeaderDefault({
  displayName,
  username,
  avatarUri,
  verified,
  isOwnProfile,
  currentUsername,
  profileId,
  isFederated,
  actorUri,
  isFollowing: initialIsFollowing,
  isFollowPending: initialIsFollowPending,
  UserNameComponent,
  FollowButtonComponent,
}: ProfileHeaderDefaultProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const canPoke = !isFederated;
  const { poked, loading: pokeLoading, toggle: togglePoke } = usePoke(profileId, isOwnProfile || Boolean(isFederated));
  useFederatedFollowSync(profileId, isFederated, actorUri);
  // Seed the follow button from the viewer's cached following set so a profile
  // the viewer already follows renders "Following" on mount instead of flashing
  // "Follow" until the status fetch resolves.
  const followingSet = useViewerFollowingSet();

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
            <LiveAvatar userId={profileId} source={avatarUri ?? undefined} size={90} variant={MEDIA_VARIANT_VIDEO_POSTER} />
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
            <TouchableOpacity
              className="border border-border bg-background items-center justify-center"
              style={{ width: 40, height: 40, borderRadius: 20 }}
              onPress={() => router.push('/insights')}
              accessibilityRole="button"
              accessibilityLabel="Analytics"
            >
              <AnalyticsIcon size={20} className="text-foreground" />
            </TouchableOpacity>
            <TouchableOpacity
              className="border border-border bg-background items-center justify-center"
              style={{ width: 40, height: 40, borderRadius: 20 }}
              onPress={() => router.push('/settings')}
              accessibilityRole="button"
              accessibilityLabel="Settings"
            >
              <Gear size={20} className="text-foreground" />
            </TouchableOpacity>
          </View>
        ) : profileId ? (
          <View className="flex-row items-center gap-3">
            {canPoke && (
              <TouchableOpacity
                className={cn(
                  'rounded-full border items-center justify-center',
                  poked ? 'bg-primary border-primary' : 'bg-background border-border',
                )}
                style={{ width: 38, height: 38 }}
                onPress={togglePoke}
                disabled={pokeLoading}
                accessibilityRole="button"
                accessibilityLabel={poked ? 'Unpoke' : 'Poke'}
              >
                <FontAwesome5
                  name="hand-point-right"
                  size={18}
                  color={poked ? theme.colors.primaryForeground : theme.colors.text}
                  solid={poked}
                />
              </TouchableOpacity>
            )}
            <FollowButtonComponent
              userId={profileId}
              initiallyFollowing={followingSet.has(profileId)}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
});

/**
 * Minimalist profile header with avatar on right
 */
export const ProfileHeaderMinimalist = memo(function ProfileHeaderMinimalist({
  displayName,
  username,
  avatarUri,
  verified,
  isPrivate,
  privacySettings,
  profileId,
  isOwnProfile,
  UserNameComponent,
  trailingBadge,
}: ProfileHeaderMinimalistProps & { profileId?: string; isOwnProfile?: boolean; trailingBadge?: React.ReactNode }) {
  const theme = useTheme();
  const { isLive } = useLiveUsers();
  const isProfileLive = isLive(profileId);
  return (
    <View className="flex-row justify-between items-start mb-4 relative w-full gap-4">
      <View className="flex-1">
        <UserNameComponent
          name={displayName}
          handle={username}
          verified={false}
          variant="default"
          trailingBadge={trailingBadge}
          style={{
            name: { fontSize: 24, fontWeight: 'bold' as const, marginTop: 10, marginBottom: 4 },
            handle: { fontSize: 15, marginBottom: 12 },
            container: undefined,
          }}
        />
        {isPrivate && <PrivateBadge privacySettings={privacySettings} />}
      </View>
      <View className="relative">
        {isProfileLive ? (
          <View className="border-[3px] border-background bg-secondary rounded-full">
            <LiveAvatar userId={profileId} source={avatarUri ?? undefined} size={70} variant={MEDIA_VARIANT_VIDEO_POSTER} />
          </View>
        ) : (
          <ZoomableAvatar
            source={avatarUri}
            size={70}
            className="border-[3px] border-background bg-secondary"
            style={{ width: 70, height: 70, borderRadius: 35 }}
            imageStyle={{}}
          />
        )}
        {verified && (
          <View className="absolute rounded-[10px] p-0.5 bg-background" style={{ left: -6, bottom: -2 }}>
            <Ionicons name="checkmark-circle" size={18} color={theme.colors.primary} />
          </View>
        )}
        {!isOwnProfile && profileId && (
          <PresenceIndicator
            userId={profileId}
            size="small"
            style={{ position: 'absolute', bottom: 2, right: 2 }}
          />
        )}
      </View>
    </View>
  );
});

/**
 * Profile action buttons for minimalist mode
 */
export const ProfileActions = memo(function ProfileActions({
  isOwnProfile,
  isFederated,
  actorUri,
  currentUsername,
  profileUsername,
  profileId,
  FollowButtonComponent,
}: {
  isOwnProfile: boolean;
  isFederated?: boolean;
  actorUri?: string;
  currentUsername?: string;
  profileUsername?: string;
  profileId?: string;
  FollowButtonComponent: FollowButtonComponentType;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const canPoke = !isFederated;
  const { poked, loading: pokeLoading, toggle: togglePoke } = usePoke(profileId, isOwnProfile || Boolean(isFederated));
  useFederatedFollowSync(profileId, isFederated, actorUri);
  const followingSet = useViewerFollowingSet();

  if (!isOwnProfile || currentUsername !== profileUsername) {
    if (!profileId) return null;
    return (
      <View className="flex-row items-center gap-3">
        {canPoke && (
          <TouchableOpacity
            className={cn(
              'rounded-full border items-center justify-center',
              poked ? 'bg-primary border-primary' : 'bg-background border-border',
            )}
            style={{ width: 38, height: 38 }}
            onPress={togglePoke}
            disabled={pokeLoading}
            accessibilityRole="button"
            accessibilityLabel={poked ? 'Unpoke' : 'Poke'}
          >
            <FontAwesome5
              name="hand-point-right"
              size={18}
              color={poked ? theme.colors.primaryForeground : theme.colors.text}
              solid={poked}
            />
          </TouchableOpacity>
        )}
        <FollowButtonComponent
          userId={profileId}
          initiallyFollowing={followingSet.has(profileId)}
        />
      </View>
    );
  }

  return (
    <View className="flex-row items-center gap-3">
      <TouchableOpacity
        className="border border-border bg-background rounded-full px-6 py-2"
        onPress={() => router.push('/edit-profile')}
        accessibilityRole="button"
        accessibilityLabel={t('profile.editProfile')}
      >
        <Text className="text-foreground text-sm font-semibold">{t('profile.editProfile')}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        className="border border-border bg-background items-center justify-center"
        style={{ width: 40, height: 40, borderRadius: 20 }}
        onPress={() => router.push('/insights')}
        accessibilityRole="button"
        accessibilityLabel="Analytics"
      >
        <AnalyticsIcon size={20} className="text-foreground" />
      </TouchableOpacity>
      <TouchableOpacity
        className="border border-border bg-background items-center justify-center"
        style={{ width: 40, height: 40, borderRadius: 20 }}
        onPress={() => router.push('/settings')}
        accessibilityRole="button"
        accessibilityLabel="Settings"
      >
        <Gear size={20} className="text-foreground" />
      </TouchableOpacity>
    </View>
  );
});
