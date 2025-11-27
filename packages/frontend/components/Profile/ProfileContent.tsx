import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import UserName from '@/components/UserName';
import {
  ProfileHeaderDefault,
  ProfileHeaderMinimalist,
  ProfileActions,
} from './ProfileHeader';
import { ProfileStats } from './ProfileStats';
import { ProfileMeta } from './ProfileMeta';
import { ProfileCommunities } from './ProfileCommunities';
import { PrivateBadge } from './PrivateBadge';
import { LAYOUT } from './types';
import type { ProfileContentProps } from './types';

/**
 * Main profile content section
 * Contains header, bio, meta info, stats, and communities
 */
export const ProfileContent = memo(function ProfileContent({
  profileData,
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
  const design = profileData.design;
  const minimalistMode = design?.minimalistMode ?? false;

  const handleLayout = (event: any) => {
    onLayout?.(event.nativeEvent.layout.height);
  };

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: theme.colors.background },
        minimalistMode && styles.containerMinimalist,
      ]}
      onLayout={handleLayout}
    >
      {minimalistMode ? (
        <ProfileHeaderMinimalist
          displayName={design?.displayName || ''}
          username={profileData.username}
          avatarUri={design?.avatar}
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
          avatarUri={design?.avatar}
          verified={profileData.verified}
          isOwnProfile={isOwnProfile}
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
            handle={profileData.username}
            verified={profileData.verified}
            variant="default"
            style={{
              name: [styles.profileName, { color: theme.colors.text }],
              handle: [styles.profileHandle, { color: theme.colors.textSecondary }],
              container: undefined,
            }}
          />
          {isPrivate && <PrivateBadge privacySettings={profileData.privacy} />}
        </View>
      )}

      {/* Bio */}
      {!minimalistMode && profileData.bio && (
        <Text style={[styles.profileBio, { color: theme.colors.text }]}>
          {profileData.bio}
        </Text>
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
  profileBio: {
    fontSize: 15,
    lineHeight: 20,
    marginBottom: 12,
  },
});



