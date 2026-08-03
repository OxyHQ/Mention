import React, { memo } from 'react';
import { View, Text, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { LinkifiedText } from '@/components/common/LinkifiedText';
import { ProfileStats } from './ProfileStats';
import { ProfileMeta } from './ProfileMeta';
import { LinkSummary } from './LinkSummary';
import { ProfileMedia } from './ProfileMedia';
import { FollowedByRow } from './FollowedByRow';
import { ProfileCommunities } from './ProfileCommunities';
import { LAYOUT } from './types';
import type { ProfileContentProps } from './types';
import { mergeBioAndProfileLinks } from '@/utils/mergeBioAndProfileLinks';
import { useAppearanceStore } from '@/stores/appearanceStore';
import { useExpandableText } from '@/hooks/useExpandableText';

/** Profile bio collapse threshold (chars) — fixed, not user-configurable; only the on/off toggle is (`collapseLongBio`). */
const BIO_COLLAPSE_CHARS = 200;

/**
 * Everything on a profile page between the identity block and the tab strip.
 *
 * Shared by both profile screens, and the sharing is the point: bio, joined
 * date, follow-graph stats, pinned media, mutual followers, links and
 * communities are the same reading of an account whoever it belongs to. What
 * differs — which header, which URL family the rows link into, whether a
 * replies stat is honest — arrives as props, so there is one implementation of
 * each row rather than one per screen.
 */
export const ProfileContent = memo(function ProfileContent({
  profileData,
  isOwnProfile,
  isPrivate,
  followingCount,
  followerCount,
  profileHandle,
  identity,
  showReplies,
  aboutHref,
  followingHref,
  followersHref,
  onPostsPress,
  onBoostsPress,
  onRepliesPress,
  onLayout,
}: ProfileContentProps) {
  const { t } = useTranslation();
  const design = profileData.design;
  const collapseLongBio =
    useAppearanceStore((s) => s.mySettings?.appearance?.collapseLongBio) ?? true;
  // `collapseLongBio` is passed as the reset key so toggling it in Settings
  // collapses the bio back to false instead of leaving it stuck expanded.
  const bioExpand = useExpandableText(
    profileData.bio ?? '',
    collapseLongBio ? BIO_COLLAPSE_CHARS : Infinity,
    collapseLongBio,
  );

  const handleLayout = (event: LayoutChangeEvent) => {
    onLayout?.(event.nativeEvent.layout.height);
  };

  return (
    <View
      className="bg-background"
      style={{
        paddingHorizontal: LAYOUT.DEFAULT_PADDING,
        paddingBottom: LAYOUT.DEFAULT_PADDING,
      }}
      onLayout={handleLayout}
    >
      {identity}

      {/* Bio. Not a view-layer nicety: the same text ships on the user DTO and
          federates as the actor's ActivityPub `summary`, so hiding it here would
          make the page disagree with what the rest of the network already reads
          — and with the owner's own edit form, which offers the field. For a
          channel it is also the only place the page says what it publishes. */}
      {profileData.bio && (
        <LinkifiedText
          text={bioExpand.displayText}
          className="text-foreground"
          style={{ fontSize: 15, lineHeight: 20, marginBottom: 12 }}
          suffix={
            bioExpand.isTruncated ? (
              <Text className="text-primary" onPress={bioExpand.toggle}>
                {bioExpand.isExpanded
                  ? ` ${t('common.showLess', 'Show less')}`
                  : ` ${t('profile.bio.readMore', 'Read more')}`}
              </Text>
            ) : null
          }
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
              <Text
                className="text-muted-foreground text-[13px] font-semibold"
                style={{ width: 100 }}
                numberOfLines={1}
              >
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
        aboutHref={aboutHref}
      />

      {/* Stats (following, followers, posts) */}
      {(!isPrivate || isOwnProfile) && (
        <ProfileStats
          followingCount={followingCount}
          followerCount={followerCount}
          postsCount={profileData.postsCount ?? 0}
          boostsCount={profileData.boostsCount ?? 0}
          repliesCount={profileData.repliesCount ?? 0}
          showReplies={showReplies}
          followingHref={followingHref}
          followersHref={followersHref}
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
      <LinkSummary
        links={mergeBioAndProfileLinks(
          profileData.linksMetadata,
          profileData.links,
          profileData.bio,
        )}
      />

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
