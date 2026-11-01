import { useScrollOffset } from '@oxy.so/bloom/layout';
import { memo, useCallback } from 'react';
import { View } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import Animated, {
  useDerivedValue,
  useSharedValue,
  useAnimatedStyle,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { ZoomableAvatar } from '@/components/ZoomableAvatar';
import { LiveAvatar } from '@/components/ui/LiveAvatar';
import { MEDIA_VARIANT_AVATAR_LG } from '@mention/shared-types/post';
import { useLiveUser } from '@/stores/livePresenceStore';
import { PresenceIndicator } from '@/components/PresenceIndicator';
import { Button } from '@oxy.so/bloom/button';
import { useSurfaceFill } from '@oxy.so/bloom/styles';
import { ButtonGroup, ButtonGroupItem } from '@oxy.so/bloom/button-group';
import { RiHand } from '@oxy.so/bloom/icons/RiHand';
import { RiLineChartLine } from '@oxy.so/bloom/icons/RiLineChartLine';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { requestSettings } from '@/components/settings/settingsRoutes';
import { usePoke } from './hooks/usePoke';
import { useFederatedFollowSync } from './hooks/useFederatedFollowSync';
import { LAYOUT } from './types';
import { PROFILE_AVATAR_RING } from './ProfilePageHeader';
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
// Settings is an app-level action with no profile-specific dependencies.
const goSettings = () => requestSettings('/settings');
const openEditProfile = () => requestSettings('/settings/edit-profile');

export const ProfileHeader = memo(function ProfileHeader({
  username,
  avatarUri,
  galleryShareUrl,
  account,
  isOwnProfile,
  currentUsername,
  profileId,
  isFederated,
  actorUri,
  isFollowing: initialIsFollowing,
  FollowButtonComponent,
  followVerb,
  interactionActions,
}: ProfileHeaderProps) {
  const router = useRouter();
  const goInsights = useCallback(() => router.push('/insights'), [router]);
  const { t } = useTranslation();
  // The ring cuts the avatar out of the banner, so it is the colour of the
  // surface the summary sits on — not the theme background, which the profile
  // is not painted in.
  const surfaceFill = useSurfaceFill();
  const canPoke = !isFederated;
  const {
    poked,
    loading: pokeLoading,
    toggle: togglePoke,
  } = usePoke(profileId, isOwnProfile || Boolean(isFederated));
  useFederatedFollowSync(profileId, isFederated, actorUri);

  // Normalized 0 → 1 collapse driver for the avatar shrink, derived on the UI
  // thread from this profile's own Screen offset, so a previous route cannot
  // leave this avatar collapsed. Maps the first HEADER_HEIGHT_EXPANDED px of
  // scroll to the full shrink; clamped past that.
  const screenOffset = useScrollOffset();
  const atRest = useSharedValue(0);
  const scrollPosition = screenOffset ?? atRest;
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
  const { isLive: isProfileLive } = useLiveUser(profileId);
  const liveAvatarCollapseStyle = useAnimatedStyle(() => ({
    transform: [
      {
        scale: interpolate(
          avatarCollapseProgress.value,
          [0, 1],
          [1, PROFILE_AVATAR_COLLAPSE_MIN_SCALE],
          Extrapolation.CLAMP,
        ),
      },
      {
        translateY: interpolate(
          avatarCollapseProgress.value,
          [0, 1],
          [0, PROFILE_AVATAR_COLLAPSE_TRANSLATE_Y],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  return (
    <View className="flex-row justify-between items-end mb-2.5">
      <View className="relative">
        {isProfileLive ? (
          <Animated.View
            className="bg-muted rounded-full"
            style={[
              { borderWidth: PROFILE_AVATAR_RING, borderColor: surfaceFill },
              liveAvatarCollapseStyle,
            ]}
          >
            <LiveAvatar
              account={account}
              userId={profileId}
              source={avatarUri ?? undefined}
              size={90}
              variant={MEDIA_VARIANT_AVATAR_LG}
            />
          </Animated.View>
        ) : (
          <ZoomableAvatar
            shareUrl={galleryShareUrl ?? null}
            account={account}
            source={avatarUri}
            size={90 - PROFILE_AVATAR_RING * 2}
            className="bg-muted"
            style={{
              width: 90,
              height: 90,
              borderRadius: 45,
              borderWidth: PROFILE_AVATAR_RING,
              borderColor: surfaceFill,
            }}
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
      <View className="flex-1 min-w-0 ml-3">
        {isOwnProfile && currentUsername === username ? (
          <View className="flex-row flex-wrap justify-end items-center gap-2">
            <Button appearance="subtle" tone="neutral" onPress={openEditProfile}>
              {t('profile.editProfile')}
            </Button>
            <ButtonGroup testID="profile-owner-actions">
              <ButtonGroupItem
                iconOnly
                onPress={goInsights}
                accessibilityLabel="Analytics"
                leadingIcon={RiLineChartLine}
              />
              <ButtonGroupItem
                iconOnly
                onPress={goSettings}
                accessibilityLabel="Settings"
                leadingIcon={RiSettings3Line}
              />
            </ButtonGroup>
          </View>
        ) : profileId ? (
          <View className="flex-row flex-wrap justify-end items-center gap-2">
            {(canPoke || interactionActions) && (
              <ButtonGroup testID="profile-interaction-actions">
                {canPoke && (
                  <ButtonGroupItem
                    iconOnly
                    onPress={togglePoke}
                    disabled={pokeLoading}
                    checked={poked}
                    accessibilityLabel={poked ? 'Unpoke' : 'Poke'}
                    leadingIcon={RiHand}
                  />
                )}
                {interactionActions}
              </ButtonGroup>
            )}
            {/* Seed from the profile DTO's authoritative viewer relationship so
                the button paints correctly on first render. When the DTO omits it,
                the app-root follow-store seed covers followed users. */}
            <FollowButtonComponent
              userId={profileId}
              initiallyFollowing={initialIsFollowing}
              username={username}
              verb={followVerb}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
});
