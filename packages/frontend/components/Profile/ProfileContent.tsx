import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import UserName from '@/components/UserName';
import LinkifiedText from '@/components/common/LinkifiedText';
import {
  ProfileHeaderDefault,
  ProfileHeaderMinimalist,
  ProfileActions,
} from './ProfileHeader';
import { ProfileStats } from './ProfileStats';
import { ProfileMeta } from './ProfileMeta';
import { LinkSummary } from './LinkSummary';
import { ProfileMedia } from './ProfileMedia';
import { FollowedByRow } from './FollowedByRow';
import { ProfileCommunities } from './ProfileCommunities';
import { PrivateBadge } from './PrivateBadge';
import { LAYOUT } from './types';
import type { ProfileContentProps } from './types';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { useAuth } from '@oxyhq/services';
import { FediverseSharingBadge } from '@/components/Fediverse/FediverseBadge';
import { mergeBioAndProfileLinks } from '@/utils/mergeBioAndProfileLinks';
import { useAppearanceStore } from '@/store/appearanceStore';
import { useExpandableText } from '@/hooks/useExpandableText';

/** Profile bio collapse threshold (chars) — fixed, not user-configurable; only the on/off toggle is (`collapseLongBio`). */
const BIO_COLLAPSE_CHARS = 200;

/**
 * Main profile content section
 * Contains header, bio, meta info, stats, and communities
 */
export const ProfileContent = memo(function ProfileContent({
  profileData,
  avatarUri,
  isOwnProfile,
  isPrivate,
  currentUsername,
  followingCount,
  followerCount,
  username,
  FollowButtonComponent,
  onPostsPress,
  onBoostsPress,
  onRepliesPress,
  onLayout,
}: ProfileContentProps) {
  const { t } = useTranslation();
  const { user, isAuthenticated } = useAuth();
  const design = profileData.design;
  const minimalistMode = design.minimalistMode;
  // Own, non-federated profile opted into fediverse sharing (absent flag ⇒ on):
  // a tappable badge next to the handle explaining the fediverse.
  const fediverseBadge =
    isOwnProfile && !profileData.isFederated && user?.fediverseSharing !== false ? (
      <FediverseSharingBadge size={20} />
    ) : undefined;
  // Passive "Follows you" tag rendered inline to the right of the @handle when
  // this profile follows the viewer. Requires an authenticated viewer (a signed-
  // out visitor has no "you") and is never shown on the viewer's own profile.
  const followsYouTag =
    !isOwnProfile && isAuthenticated && profileData.followsYou ? (
      <View className="bg-secondary px-2 py-0.5 rounded-full">
        <Text className="text-muted-foreground text-xs font-medium" numberOfLines={1}>
          {t('profile.followsYou', { defaultValue: 'Follows you' })}
        </Text>
      </View>
    ) : undefined;
  const profileHandle = getNormalizedUserHandle({
    username: profileData.username || username,
    instance: profileData.instance,
    isFederated: profileData.isFederated,
  }) || username;
  const collapseLongBio = useAppearanceStore((s) => s.mySettings?.appearance?.collapseLongBio) ?? true;
  // `collapseLongBio` is passed as the reset key so toggling it in Settings
  // collapses the bio back to false instead of leaving it stuck expanded.
  const bioExpand = useExpandableText(profileData.bio ?? '', collapseLongBio ? BIO_COLLAPSE_CHARS : Infinity, collapseLongBio);

  const handleLayout = (event: LayoutChangeEvent) => {
    onLayout?.(event.nativeEvent.layout.height);
  };

  const userNameStyle = useMemo(() => ({
    name: { fontSize: 24, fontWeight: 'bold' as const, marginTop: 10, marginBottom: 4 },
    handle: { fontSize: 15, marginBottom: 12 },
    container: undefined,
  }), []);

  return (
    <View
      className="bg-background"
      style={[
        { paddingHorizontal: LAYOUT.DEFAULT_PADDING, paddingBottom: LAYOUT.DEFAULT_PADDING },
        minimalistMode && { paddingTop: 0, marginTop: 0 },
      ]}
      onLayout={handleLayout}
    >
      {minimalistMode ? (
        <ProfileHeaderMinimalist
          displayName={design.displayName}
          username={profileData.username}
          avatarUri={avatarUri}
          verified={profileData.verified}
          isPrivate={isPrivate}
          privacySettings={profileData.privacy}
          isOwnProfile={isOwnProfile}
          trailingBadge={fediverseBadge}

          UserNameComponent={UserName}
        />
      ) : (
        <ProfileHeaderDefault
          displayName={design.displayName}
          username={profileData.username}
          avatarUri={avatarUri}
          verified={profileData.verified}
          isOwnProfile={isOwnProfile}
          isFederated={profileData.isFederated}
          actorUri={profileData.actorUri}
          isFollowing={profileData.isFollowing}
          isFollowPending={profileData.isFollowPending}
          currentUsername={currentUsername}
          profileId={profileData.id}

          UserNameComponent={UserName}
          FollowButtonComponent={FollowButtonComponent}
        />
      )}

      {/* Action buttons for minimalist mode */}
      {minimalistMode && (
        <View className="mt-3 mb-2">
          <ProfileActions
            isOwnProfile={isOwnProfile}
            isFederated={profileData.isFederated}
            actorUri={profileData.actorUri}
            currentUsername={currentUsername}
            profileUsername={profileData.username}
            profileId={profileData.id}
            isFollowing={profileData.isFollowing}
            FollowButtonComponent={FollowButtonComponent}
          />
        </View>
      )}

      {/* Name and handle for default mode */}
      {!minimalistMode && (
        <View>
          <UserName
            name={design?.displayName}
            handle={profileData.username}
            verified={profileData.verified}
            isFederated={profileData.isFederated}
            copyableHandle
            variant="default"
            style={userNameStyle}
            trailingBadge={fediverseBadge}
            handleTrailing={followsYouTag}
          />
          {isPrivate && (
            <View className="flex-row items-center gap-2 flex-wrap">
              <PrivateBadge privacySettings={profileData.privacy} />
            </View>
          )}
        </View>
      )}

      {/* Bio */}
      {!minimalistMode && profileData.bio && (
        <LinkifiedText
          text={bioExpand.displayText}
          className="text-foreground"
          style={{ fontSize: 15, lineHeight: 20, marginBottom: 12 }}
          suffix={bioExpand.isTruncated ? (
            <Text
              className="text-primary"
              onPress={bioExpand.toggle}
            >
              {bioExpand.isExpanded ? ` ${t('common.showLess', 'Show less')}` : ` ${t('profile.bio.readMore', 'Read more')}`}
            </Text>
          ) : null}
        />
      )}

      {/* Profile fields (federated profiles) */}
      {profileData.isFederated && profileData.fields && profileData.fields.length > 0 && (
        <View className="mb-3" style={{ gap: 1 }}>
          {profileData.fields.map((field, i) => (
            <View
              key={i}
              className="flex-row items-center py-1.5 border-b border-border gap-2"
              style={{ borderBottomWidth: StyleSheet.hairlineWidth }}
            >
              <Text className="text-muted-foreground text-[13px] font-semibold" style={{ width: 100 }} numberOfLines={1}>
                {field.name}
              </Text>
              <LinkifiedText
                text={field.value?.replace(/<[^>]*>/g, '') || ''}
                className="text-foreground"
                style={{ fontSize: 14, flex: 1 }}
              />
              {field.verifiedAt && (
                <Ionicons name="checkmark-circle" size={14} color="#2ecc71" />
              )}
            </View>
          ))}
        </View>
      )}

      {/* Meta info (location, join date) */}
      <ProfileMeta
        location={profileData.primaryLocation}
        createdAt={profileData.createdAt}
        username={username}
        profileHandle={profileHandle}
      />

      {/* Stats (following, followers, posts) */}
      {(!isPrivate || isOwnProfile) && (
        <ProfileStats
          followingCount={followingCount}
          followerCount={followerCount}
          postsCount={profileData.postsCount ?? 0}
          boostsCount={profileData.boostsCount ?? 0}
          repliesCount={profileData.repliesCount ?? 0}
          profileUsername={profileData.username}
          profileHandle={profileHandle}
          username={username}
          onPostsPress={onPostsPress}
          onBoostsPress={onBoostsPress}
          onRepliesPress={onRepliesPress}
        />
      )}

      {/* Profile media — SONG branch renders here, right after the stats, when
          pinned (nothing renders when empty; management now lives on the Edit
          Profile screen). The PODCAST branch renders as a card at the bottom
          of the header instead (Threads-style), so it is skipped here. */}
      {(!isPrivate || isOwnProfile) && design.profileMedia?.type !== 'podcast' && (
        <ProfileMedia media={design.profileMedia ?? null} isOwnProfile={isOwnProfile} />
      )}

      {/* Social proof — mutual followers ("Followed by Ana, Luis and N others") */}
      <FollowedByRow profileId={profileData.id} username={profileHandle} />

      {/* Links (Instagram-style summary row + bottom sheet) */}
      <LinkSummary links={mergeBioAndProfileLinks(profileData.linksMetadata, profileData.links, profileData.bio)} />

      {/* Communities */}
      {profileData.communities &&
        profileData.communities.length > 0 &&
        (!isPrivate || isOwnProfile) && (
          <ProfileCommunities communities={profileData.communities} />
        )}

      {/* Profile media — PODCAST branch renders last (the bottom of the header,
          before the posts feed), matching the Threads card placement. */}
      {(!isPrivate || isOwnProfile) && design.profileMedia?.type === 'podcast' && (
        <ProfileMedia media={design.profileMedia} isOwnProfile={isOwnProfile} />
      )}
    </View>
  );
});
