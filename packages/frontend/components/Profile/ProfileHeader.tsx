import React, { memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { ZoomableAvatar } from '@/components/ZoomableAvatar';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { Gear } from '@/assets/icons/gear-icon';
import { PrivateBadge } from './PrivateBadge';
import type {
  ProfileHeaderDefaultProps,
  ProfileHeaderMinimalistProps,
  UserNameComponent,
} from './types';

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
  theme,
  UserNameComponent,
  FollowButtonComponent,
  showBottomSheet,
}: ProfileHeaderDefaultProps) {
  const { t } = useTranslation();

  return (
    <View style={styles.avatarRow}>
      <ZoomableAvatar
        source={avatarUri}
        size={90}
        style={[
          styles.avatar,
          {
            borderColor: theme.colors.background,
            backgroundColor: theme.colors.backgroundSecondary,
          },
        ]}
        imageStyle={{}}
      />
      <View style={styles.profileActions}>
        {isOwnProfile && currentUsername === username ? (
          <View style={styles.actionButtons}>
            <TouchableOpacity
              style={[styles.followButton, { backgroundColor: theme.colors.primary }]}
              onPress={() => showBottomSheet?.('EditProfile')}
            >
              <Text style={styles.followButtonText}>{t('profile.editProfile')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.settingsButton,
                { backgroundColor: theme.colors.background, borderColor: theme.colors.border },
              ]}
              onPress={() => router.push('/insights')}
            >
              <AnalyticsIcon size={20} color={theme.colors.text} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.settingsButton,
                { backgroundColor: theme.colors.background, borderColor: theme.colors.border },
              ]}
              onPress={() => router.push('/settings')}
            >
              <Gear size={20} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        ) : profileId ? (
          <FollowButtonComponent userId={profileId} />
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
  theme,
  UserNameComponent,
}: ProfileHeaderMinimalistProps) {
  return (
    <View style={styles.minimalistHeader}>
      <View style={styles.minimalistInfo}>
        <UserNameComponent
          name={displayName}
          handle={username}
          verified={false}
          variant="default"
          style={{
            name: [styles.profileName, { color: theme.colors.text }],
            handle: [styles.profileHandle, { color: theme.colors.textSecondary }],
            container: undefined,
          }}
        />
        {isPrivate && <PrivateBadge privacySettings={privacySettings} />}
      </View>
      <View style={styles.minimalistAvatarContainer}>
        <ZoomableAvatar
          source={avatarUri}
          size={70}
          style={[
            styles.avatarMinimalist,
            {
              borderColor: theme.colors.background,
              backgroundColor: theme.colors.backgroundSecondary,
            },
          ]}
          imageStyle={{}}
        />
        {verified && (
          <View style={[styles.verifiedBadge, { backgroundColor: theme.colors.background }]}>
            <Ionicons name="checkmark-circle" size={18} color={theme.colors.primary} />
          </View>
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
  currentUsername,
  profileUsername,
  profileId,
  FollowButtonComponent,
  showBottomSheet,
}: {
  isOwnProfile: boolean;
  currentUsername?: string;
  profileUsername?: string;
  profileId?: string;
  FollowButtonComponent: React.ComponentType<{ userId: string }>;
  showBottomSheet?: (sheet: string) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();

  if (!isOwnProfile || currentUsername !== profileUsername) {
    return profileId ? <FollowButtonComponent userId={profileId} /> : null;
  }

  return (
    <View style={styles.actionButtons}>
      <TouchableOpacity
        style={[styles.followButton, { backgroundColor: theme.colors.primary }]}
        onPress={() => showBottomSheet?.('EditProfile')}
      >
        <Text style={styles.followButtonText}>{t('profile.editProfile')}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.settingsButton,
          { backgroundColor: theme.colors.background, borderColor: theme.colors.border },
        ]}
        onPress={() => router.push('/insights')}
      >
        <AnalyticsIcon size={20} color={theme.colors.text} />
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.settingsButton,
          { backgroundColor: theme.colors.background, borderColor: theme.colors.border },
        ]}
        onPress={() => router.push('/settings')}
      >
        <Gear size={20} color={theme.colors.text} />
      </TouchableOpacity>
    </View>
  );
});

const styles = StyleSheet.create({
  avatarRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: -45,
    marginBottom: 10,
  },
  avatar: {
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 4,
  },
  profileActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  followButton: {
    paddingHorizontal: 24,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  followButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  settingsButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  minimalistHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
    position: 'relative',
    width: '100%',
  },
  minimalistInfo: {
    flex: 1,
    marginRight: 16,
  },
  minimalistAvatarContainer: {
    position: 'relative',
  },
  avatarMinimalist: {
    width: 70,
    height: 70,
    borderRadius: 35,
    borderWidth: 2,
  },
  verifiedBadge: {
    position: 'absolute',
    left: -6,
    bottom: -2,
    borderRadius: 10,
    padding: 2,
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
});




