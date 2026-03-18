import React, { memo, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { ZoomableAvatar } from '@/components/ZoomableAvatar';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { Gear } from '@/assets/icons/gear-icon';
import { PrivateBadge } from './PrivateBadge';
import { PresenceIndicator } from '@/components/PresenceIndicator';
import { usePoke } from './hooks/usePoke';
import { federationService } from '@/services/federationService';
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
  theme,
  UserNameComponent,
  FollowButtonComponent,
  showBottomSheet,
}: ProfileHeaderDefaultProps) {
  const { t } = useTranslation();
  const { poked, loading: pokeLoading, toggle: togglePoke } = usePoke(profileId, isOwnProfile || !!isFederated);

  // Federated follow state — initialized from profileData
  const [fedFollowing, setFedFollowing] = useState(!!initialIsFollowing);
  const [fedFollowPending, setFedFollowPending] = useState(!!initialIsFollowPending);
  const [fedFollowLoading, setFedFollowLoading] = useState(false);

  const handleFederatedFollow = useCallback(async () => {
    if (!actorUri) return;
    setFedFollowLoading(true);
    try {
      if (fedFollowing || fedFollowPending) {
        await federationService.unfollow(actorUri);
        setFedFollowing(false);
        setFedFollowPending(false);
      } else {
        const result = await federationService.follow(actorUri);
        setFedFollowing(!result.pending);
        setFedFollowPending(!!result.pending);
      }
    } finally {
      setFedFollowLoading(false);
    }
  }, [actorUri, fedFollowing, fedFollowPending]);

  const fedFollowLabel = fedFollowPending ? 'Pending' : fedFollowing ? 'Following' : 'Follow';

  return (
    <View className="flex-row justify-between items-end mb-2.5" style={{ marginTop: -45 }}>
      <View className="relative">
        <ZoomableAvatar
          source={avatarUri}
          size={90}
          style={{
            width: 90,
            height: 90,
            borderRadius: 45,
            borderWidth: 4,
            borderColor: theme.colors.background,
            backgroundColor: theme.colors.backgroundSecondary,
          }}
          imageStyle={{}}
        />
        {!isOwnProfile && !isFederated && profileId && (
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
              className="border rounded-full px-6 py-2"
              style={{ backgroundColor: theme.colors.background, borderColor: theme.colors.border }}
              onPress={() => showBottomSheet?.('AccountSettings')}
              accessibilityRole="button"
              accessibilityLabel={t('profile.editProfile')}
            >
              <Text className="text-foreground text-sm font-semibold">{t('profile.editProfile')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="border items-center justify-center"
              style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: theme.colors.background, borderColor: theme.colors.border }}
              onPress={() => router.push('/insights')}
              accessibilityRole="button"
              accessibilityLabel="Analytics"
            >
              <AnalyticsIcon size={20} className="text-foreground" />
            </TouchableOpacity>
            <TouchableOpacity
              className="border items-center justify-center"
              style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: theme.colors.background, borderColor: theme.colors.border }}
              onPress={() => router.push('/settings')}
              accessibilityRole="button"
              accessibilityLabel="Settings"
            >
              <Gear size={20} className="text-foreground" />
            </TouchableOpacity>
          </View>
        ) : isFederated && actorUri ? (
          <View className="flex-row items-center gap-3">
            <TouchableOpacity
              className="border rounded-full px-6 py-2"
              style={{
                backgroundColor: fedFollowing || fedFollowPending ? theme.colors.background : theme.colors.primary,
                borderColor: fedFollowing || fedFollowPending ? theme.colors.border : theme.colors.primary,
              }}
              onPress={handleFederatedFollow}
              disabled={fedFollowLoading}
              accessibilityRole="button"
              accessibilityLabel={fedFollowLabel}
            >
              {fedFollowLoading ? (
                <ActivityIndicator size="small" color={fedFollowing || fedFollowPending ? theme.colors.text : '#fff'} />
              ) : (
                <Text className="text-sm font-semibold" style={{ color: fedFollowing || fedFollowPending ? theme.colors.text : '#fff' }}>
                  {fedFollowLabel}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        ) : profileId ? (
          <View className="flex-row items-center gap-3">
            <TouchableOpacity
              className="border items-center justify-center"
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: poked ? theme.colors.primary : theme.colors.background,
                borderColor: poked ? theme.colors.primary : theme.colors.border,
              }}
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
  theme,
  UserNameComponent,
}: ProfileHeaderMinimalistProps & { profileId?: string; isOwnProfile?: boolean }) {
  return (
    <View className="flex-row justify-between items-start mb-4 relative w-full">
      <View className="flex-1 mr-4">
        <UserNameComponent
          name={displayName}
          handle={username}
          verified={false}
          variant="default"
          style={{
            name: { fontSize: 24, fontWeight: 'bold' as const, marginTop: 10, marginBottom: 4, color: theme.colors.text },
            handle: { fontSize: 15, marginBottom: 12, color: theme.colors.textSecondary },
            container: undefined,
          }}
        />
        {isPrivate && <PrivateBadge privacySettings={privacySettings} />}
      </View>
      <View className="relative">
        <ZoomableAvatar
          source={avatarUri}
          size={70}
          style={{
            width: 70,
            height: 70,
            borderRadius: 35,
            borderWidth: 2,
            borderColor: theme.colors.background,
            backgroundColor: theme.colors.backgroundSecondary,
          }}
          imageStyle={{}}
        />
        {verified && (
          <View className="absolute rounded-[10px] p-0.5" style={{ left: -6, bottom: -2, backgroundColor: theme.colors.background }}>
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
  const { poked, loading: pokeLoading, toggle: togglePoke } = usePoke(profileId, isOwnProfile);

  if (!isOwnProfile || currentUsername !== profileUsername) {
    if (!profileId) return null;
    return (
      <View className="flex-row items-center gap-3">
        <TouchableOpacity
          className="border items-center justify-center"
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: poked ? theme.colors.primary : theme.colors.background,
            borderColor: poked ? theme.colors.primary : theme.colors.border,
          }}
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
        className="border rounded-full px-6 py-2"
        style={{ backgroundColor: theme.colors.background, borderColor: theme.colors.border }}
        onPress={() => showBottomSheet?.('AccountSettings')}
        accessibilityRole="button"
        accessibilityLabel={t('profile.editProfile')}
      >
        <Text className="text-foreground text-sm font-semibold">{t('profile.editProfile')}</Text>
      </TouchableOpacity>
      <TouchableOpacity
        className="border items-center justify-center"
        style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: theme.colors.background, borderColor: theme.colors.border }}
        onPress={() => router.push('/insights')}
        accessibilityRole="button"
        accessibilityLabel="Analytics"
      >
        <AnalyticsIcon size={20} className="text-foreground" />
      </TouchableOpacity>
      <TouchableOpacity
        className="border items-center justify-center"
        style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: theme.colors.background, borderColor: theme.colors.border }}
        onPress={() => router.push('/settings')}
        accessibilityRole="button"
        accessibilityLabel="Settings"
      >
        <Gear size={20} className="text-foreground" />
      </TouchableOpacity>
    </View>
  );
});
