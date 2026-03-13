import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import UserName from '@/components/UserName';
import LinkifiedText from '@/components/common/LinkifiedText';
import {
  ProfileHeaderDefault,
  ProfileHeaderMinimalist,
  ProfileActions,
} from './ProfileHeader';
import { ProfileStats } from './ProfileStats';
import { ProfileMeta } from './ProfileMeta';
import { ProfileCommunities } from './ProfileCommunities';
import { PrivateBadge } from './PrivateBadge';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';
import { LAYOUT } from './types';
import type { ProfileContentProps } from './types';

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
  showBottomSheet,
  onPostsPress,
  onLayout,
}: ProfileContentProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const design = profileData.design;
  const minimalistMode = design?.minimalistMode ?? false;

  const handleLayout = (event: any) => {
    onLayout?.(event.nativeEvent.layout.height);
  };

  const userNameStyle = useMemo(() => ({
    name: [styles.profileName, { color: theme.colors.text }],
    handle: [styles.profileHandle, { color: theme.colors.textSecondary }],
    container: undefined,
  }), [theme.colors.text, theme.colors.textSecondary]);

  return (
    <View
      className="bg-background"
      style={[
        styles.container,
        minimalistMode && styles.containerMinimalist,
      ]}
      onLayout={handleLayout}
    >
      {minimalistMode ? (
        <ProfileHeaderMinimalist
          displayName={design?.displayName || ''}
          username={profileData.username}
          avatarUri={avatarUri}
          verified={profileData.verified}
          isPrivate={isPrivate}
          privacySettings={profileData.privacy}
          theme={theme}
          UserNameComponent={UserName}
        />
      ) : (
        <ProfileHeaderDefault
          displayName={design?.displayName || ''}
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
          theme={theme}
          UserNameComponent={UserName}
          FollowButtonComponent={FollowButtonComponent}
          showBottomSheet={showBottomSheet}
        />
      )}

      {/* Action buttons for minimalist mode */}
      {minimalistMode && (
        <View style={styles.minimalistActions}>
          <ProfileActions
            isOwnProfile={isOwnProfile}
            currentUsername={currentUsername}
            profileUsername={profileData.username}
            profileId={profileData.id}
            FollowButtonComponent={FollowButtonComponent}
            showBottomSheet={showBottomSheet}
          />
        </View>
      )}

      {/* Name and handle for default mode */}
      {!minimalistMode && (
        <View>
          <UserName
            name={design?.displayName}
            handle={profileData.isFederated ? profileData.username.split('@')[0] : profileData.username}
            verified={profileData.verified}
            variant="default"
            style={userNameStyle}
          />
          <View style={styles.badgeRow}>
            {isPrivate && <PrivateBadge privacySettings={profileData.privacy} />}
            {profileData.isFederated && profileData.instance && (
              <View className="bg-muted" style={styles.fediverseBadge}>
                <FediverseIcon size={12} color={theme.colors.textSecondary} />
                <Text className="text-muted-foreground" style={styles.fediverseText}>
                  {profileData.instance}
                </Text>
              </View>
            )}
            {!isOwnProfile && profileData.followsYou && (
              <View className="bg-muted" style={styles.followsYouBadge}>
                <Text className="text-muted-foreground" style={styles.followsYouText}>
                  {t('profile.followsYou', { defaultValue: 'Follows you' })}
                </Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Bio */}
      {!minimalistMode && profileData.bio && (
        <LinkifiedText
          text={profileData.bio}
          className="text-foreground"
          style={styles.profileBio}
          linkStyle={{ color: theme.colors.primary }}
        />
      )}

      {/* Profile fields (federated profiles) */}
      {profileData.isFederated && profileData.fields && profileData.fields.length > 0 && (
        <View style={styles.fieldsContainer}>
          {profileData.fields.map((field: any, i: number) => (
            <View key={i} className="border-border" style={styles.fieldItem}>
              <Text className="text-muted-foreground" style={styles.fieldName} numberOfLines={1}>
                {field.name}
              </Text>
              <LinkifiedText
                text={field.value?.replace(/<[^>]*>/g, '') || ''}
                className="text-foreground"
                style={styles.fieldValue}
                linkStyle={{ color: theme.colors.primary }}
              />
              {field.verifiedAt && (
                <Ionicons name="checkmark-circle" size={14} color="#2ecc71" style={styles.fieldVerified} />
              )}
            </View>
          ))}
        </View>
      )}

      {/* Meta info (location, links, join date) */}
      <ProfileMeta
        location={profileData.primaryLocation}
        links={profileData.links}
        createdAt={profileData.createdAt}
        username={username}
      />

      {/* Stats (following, followers, posts) */}
      {(!isPrivate || isOwnProfile) && (
        <ProfileStats
          followingCount={followingCount}
          followerCount={followerCount}
          postsCount={profileData.postsCount ?? 0}
          profileUsername={profileData.username}
          username={username}
          onPostsPress={onPostsPress}
        />
      )}

      {/* Communities */}
      {profileData.communities &&
        profileData.communities.length > 0 &&
        (!isPrivate || isOwnProfile) && (
          <ProfileCommunities communities={profileData.communities} />
        )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: LAYOUT.DEFAULT_PADDING,
    paddingBottom: LAYOUT.DEFAULT_PADDING,
  },
  containerMinimalist: {
    paddingTop: 0,
    marginTop: 0,
  },
  minimalistActions: {
    marginTop: 12,
    marginBottom: 8,
  },
  profileName: {
    fontSize: 24,
    fontWeight: 'bold',
    marginTop: 10,
    marginBottom: 4,
  },
  profileHandle: {
    fontSize: 15,
    marginBottom: 12,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  fediverseBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  fediverseText: {
    fontSize: 12,
    fontWeight: '500',
  },
  followsYouBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  followsYouText: {
    fontSize: 12,
    fontWeight: '500',
  },
  profileBio: {
    fontSize: 15,
    lineHeight: 20,
    marginBottom: 12,
  },
  fieldsContainer: {
    marginBottom: 12,
    gap: 1,
  },
  fieldItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fieldName: {
    fontSize: 13,
    fontWeight: '600',
    width: 100,
    marginRight: 8,
  },
  fieldValue: {
    fontSize: 14,
    flex: 1,
  },
  fieldVerified: {
    marginLeft: 4,
  },
});
















