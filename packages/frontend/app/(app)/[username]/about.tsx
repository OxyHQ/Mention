import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_VIDEO_POSTER } from '@mention/shared-types';
import { useLocalSearchParams } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@oxyhq/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import UserName from '@/components/UserName';
import { RowIcon } from '@/components/settings/RowIcon';
import { VerifiedIcon } from '@/assets/icons/verified-icon';
import { CalendarMonthIcon } from '@/assets/icons/calendar-month-icon';
import { useProfileData } from '@/hooks/useProfileData';
import type { ProfileData } from '@/hooks/useProfileData';
import { useProfileScreenColor } from '@/hooks/useProfileScreenColor';
import { BloomColorScope } from '@oxyhq/bloom/theme';
import { Loading } from '@oxyhq/bloom/loading';

export default function AccountInfoScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const cleanUsername = username?.startsWith('@') ? username.slice(1) : username || '';
  const { data: profileData, loading: profileLoading } = useProfileData(cleanUsername);
  const { colorName: profileColorName } = useProfileScreenColor({
    username: cleanUsername,
    designColor: profileData?.design.color,
  });

  return (
    <BloomColorScope colorPreset={profileColorName} asChild>
      <AccountInfoContent profileData={profileData} profileLoading={profileLoading} />
    </BloomColorScope>
  );
}

interface AccountInfoContentProps {
  profileData: ProfileData | null;
  profileLoading: boolean;
}

function AccountInfoContent({ profileData, profileLoading }: AccountInfoContentProps) {
  const insets = useSafeAreaInsets();
  const safeBack = useSafeBack();
  const { t } = useTranslation();
  const theme = useTheme();

  // Format join date
  const joinDate = useMemo(() => {
    if (!profileData?.createdAt) return null;
    return new Date(profileData.createdAt).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric'
    });
  }, [profileData?.createdAt]);

  // Format verified date if available (using createdAt as fallback)
  const verifiedDate = useMemo(() => {
    if (!profileData?.verified) return null;
    // If we have a verifiedAt date, use it, otherwise use createdAt
    const dateToUse = profileData.verifiedAt || profileData.createdAt;
    if (!dateToUse) return null;
    return new Date(dateToUse).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric'
    });
  }, [profileData?.verified, profileData?.verifiedAt, profileData?.createdAt]);

  // Sized to the 56px avatar header row; matches the old hand-built name/handle
  // sizing (18px bold name, 15px muted handle) while rendering identity through
  // the shared UserName component (same VerifiedIcon as the profile header).
  const headerNameStyle = useMemo(() => ({
    name: { fontSize: 18, fontWeight: '700' as const },
    handle: { fontSize: 15 },
  }), []);

  if (profileLoading) {
    return (
      <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
        <Header
          options={{
            title: t('About', { defaultValue: 'About' }),
            leftComponents: [
              <IconButton key="back" variant="icon" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder={true}
          disableSticky={true}
        />
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </ThemedView>
    );
  }

  if (!profileData) {
    return (
      <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
        <Header
          options={{
            title: t('About', { defaultValue: 'About' }),
            leftComponents: [
              <IconButton key="back" variant="icon" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder={true}
          disableSticky={true}
        />
        <View className="flex-1 items-center justify-center px-6">
          <ThemedText className="text-base text-muted-foreground text-center">
            {t('profile.notFound.title', { defaultValue: 'Profile not found' })}
          </ThemedText>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
      <Header
        options={{
          title: t('About', { defaultValue: 'About' }),
          leftComponents: [
            <IconButton
              key="back"
              variant="icon"
              onPress={() => safeBack()}
            >
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16, paddingBottom: 20 }}
      >
        {/* Profile Header */}
        <View className="flex-row items-center mb-4 gap-3 overflow-visible">
          <View className="relative overflow-visible">
            <Avatar
              source={profileData.design.avatar || profileData.avatar}
              size={56}
              variant={MEDIA_VARIANT_VIDEO_POSTER}
              verified={profileData.verified}
            />
          </View>
          <View className="flex-1">
            <UserName
              name={profileData.design?.displayName ?? profileData.name?.displayName}
              handle={profileData.username}
              verified={profileData.verified}
              isFederated={profileData.isFederated}
              variant="default"
              style={headerNameStyle}
            />
          </View>
        </View>

        {/* Account Details */}
        <SettingsListGroup title={t('Account details', { defaultValue: 'Account details' })}>
          {/* Date Joined */}
          {joinDate && (
            <SettingsListItem
              icon={<CalendarMonthIcon size={20} color={theme.colors.textSecondary} />}
              title={t('Date joined', { defaultValue: 'Date joined' })}
              value={joinDate}
            />
          )}

          {/* Account Based In */}
          {profileData.primaryLocation && (
            <SettingsListItem
              icon={<RowIcon name="location" />}
              title={t('Account based in', { defaultValue: 'Account based in' })}
              value={profileData.primaryLocation}
            />
          )}

          {/* Verified */}
          {profileData.verified && (
            <SettingsListItem
              icon={<VerifiedIcon size={20} className="text-primary" />}
              title={t('Verified', { defaultValue: 'Verified' })}
              value={verifiedDate
                ? t('Since {date}', { date: verifiedDate, defaultValue: `Since ${verifiedDate}` })
                : t('Verified account', { defaultValue: 'Verified account' })}
            />
          )}

          {/* Username Changes */}
          {(profileData.usernameChangeCount ?? 0) > 0 && (
            <SettingsListItem
              icon={<RowIcon name="at" />}
              title={t('Username changes', { defaultValue: 'Username changes' })}
              value={String(profileData.usernameChangeCount)}
            />
          )}

          {/* Connected Via */}
          {profileData.connectedVia && (
            <SettingsListItem
              icon={<RowIcon name="globe" />}
              title={t('Connected via', { defaultValue: 'Connected via' })}
              value={profileData.connectedVia}
            />
          )}
        </SettingsListGroup>
      </ScrollView>
    </ThemedView>
  );
}
