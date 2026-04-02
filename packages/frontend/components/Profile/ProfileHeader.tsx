import React, { memo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { cn } from '@/lib/utils';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { ZoomableAvatar } from '@/components/ZoomableAvatar';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { Gear } from '@/assets/icons/gear-icon';
import { PrivateBadge } from './PrivateBadge';
import { PresenceIndicator } from '@/components/PresenceIndicator';
import { usePoke } from './hooks/usePoke';
import { useFederatedFollowSync } from './hooks/useFederatedFollowSync';
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
  isFederated,
  actorUri,
  isFollowing: initialIsFollowing,
  isFollowPending: initialIsFollowPending,
  UserNameComponent,
  FollowButtonComponent,
  showBottomSheet,
}: Omit<ProfileHeaderDefaultProps, 'theme'>) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { poked, loading: pokeLoading, toggle: togglePoke } = usePoke(profileId, isOwnProfile);
  useFederatedFollowSync(profileId, isFederated, actorUri);

  return (
    <View className="flex-row justify-between items-end mb-2.5" style={{ marginTop: -45 }}>
      <View className="relative">
        <ZoomableAvatar
          source={avatarUri}
          size={90}
          className="border-4 border-background bg-secondary"
          style={{ width: 90, height: 90, borderRadius: 45 }}
          imageStyle={{}}
        />
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
              onPress={() => showBottomSheet?.('AccountSettings')}
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
            <TouchableOpacity
              className={cn(
                'w-10 h-10 rounded-full border items-center justify-center',
                poked ? 'bg-primary border-primary' : 'bg-background border-border',
              )}
              onPress={togglePoke}
              disabled={pokeLoading}
              accessibilityRole="button"
              accessibilityLabel={poked ? 'Unpoke' : 'Poke'}
            >
              <Ionicons name={poked ? 'hand-left' : 'hand-left-outline'} size={20} color={poked ? '#fff' : theme.colors.text} />
            </TouchableOpacity>
            <FollowButtonComponent userId={profileId} />
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
}: Omit<ProfileHeaderMinimalistProps, 'theme'> & { profileId?: string; isOwnProfile?: boolean }) {
  const theme = useTheme();
  return (
    <View className="flex-row justify-between items-start mb-4 relative w-full">
      <View className="flex-1 mr-4">
        <UserNameComponent
          name={displayName}
          handle={username}
          verified={false}
          variant="default"
          style={{
            name: { fontSize: 24, fontWeight: 'bold' as const, marginTop: 10, marginBottom: 4 },
            handle: { fontSize: 15, marginBottom: 12 },
            container: undefined,
          }}
        />
        {isPrivate && <PrivateBadge privacySettings={privacySettings} />}
      </View>
      <View className="relative">
        <ZoomableAvatar
          source={avatarUri}
          size={70}
          className="border-2 border-background bg-secondary"
          style={{ width: 70, height: 70, borderRadius: 35 }}
          imageStyle={{}}
        />
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
  showBottomSheet,
}: {
  isOwnProfile: boolean;
  isFederated?: boolean;
  actorUri?: string;
  currentUsername?: string;
  profileUsername?: string;
  profileId?: string;
  FollowButtonComponent: React.ComponentType<{ userId: string }>;
  showBottomSheet?: (sheet: string) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { poked, loading: pokeLoading, toggle: togglePoke } = usePoke(profileId, isOwnProfile);
  useFederatedFollowSync(profileId, isFederated, actorUri);

  if (!isOwnProfile || currentUsername !== profileUsername) {
    if (!profileId) return null;
    return (
      <View className="flex-row items-center gap-3">
        <TouchableOpacity
          className={cn(
            'w-10 h-10 rounded-full border items-center justify-center',
            poked ? 'bg-primary border-primary' : 'bg-background border-border',
          )}
          onPress={togglePoke}
          disabled={pokeLoading}
          accessibilityRole="button"
          accessibilityLabel={poked ? 'Unpoke' : 'Poke'}
        >
          <Ionicons name={poked ? 'hand-left' : 'hand-left-outline'} size={20} color={poked ? '#fff' : theme.colors.text} />
        </TouchableOpacity>
        <FollowButtonComponent userId={profileId} />
      </View>
    );
  }

  return (
    <View className="flex-row items-center gap-3">
      <TouchableOpacity
        className="border border-border bg-background rounded-full px-6 py-2"
        onPress={() => showBottomSheet?.('AccountSettings')}
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
