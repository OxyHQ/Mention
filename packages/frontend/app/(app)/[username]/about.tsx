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

  // Same back-nav header the sibling profile sub-screens (followers / following /
  // connections) render: shared <Header>, non-sticky, no bottom border. Rendered
  // once and reused across the loading / not-found / loaded states so all three
  // share identical chrome.
  const header = (
    <Header
      options={{
        title: t('About', { defaultValue: 'About' }),
        leftComponents: [
          <IconButton key="back" variant="icon" onPress={() => safeBack()}>
            <BackArrowIcon size={20} className="text-foreground" />
          </IconButton>,
        ],
      }}
      hideBottomBorder
      disableSticky
    />
  );

  if (profileLoading) {
    return (
      <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </ThemedView>
    );
  }

  if (!profileData) {
    return (
      <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
        {header}
        <View className="flex-1 items-center justify-center px-6">
          <ThemedText className="text-base text-muted-foreground text-center">
            {t('profile.notFound.title', { defaultValue: 'Profile not found' })}
          </ThemedText>
        </View>
      </ThemedView>
    );
  }

  const avatarUri = profileData.design.avatar ?? profileData.avatar;
  const hasUsernameChanges = (profileData.usernameChangeCount ?? 0) > 0;
  const hasAccountDetails =
    Boolean(joinDate) ||
    Boolean(profileData.primaryLocation) ||
    hasUsernameChanges ||
    Boolean(profileData.connectedVia);

  return (
    <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
      {header}

      {/* Horizontal padding lives on the identity block and the Bloom settings
          groups (which carry their own 16px card margin), NOT on the scroller —
          so both align to the same 16px gutter as the profile header, and the
          settings cards are never double-inset. Vertical rhythm mirrors the
          settings screens (the app's other SettingsListGroup surface). */}
      <ScrollView className="flex-1" contentContainerClassName="pb-6">
        {/* Identity header — mirrors the profile header's avatar-then-name/handle
            vertical rhythm and typographic scale (24px display name, 15px muted
            @handle, inline verified / federated badge via the shared UserName), so
            it reads as the same identity surface as the profile screen. */}
        <View className="px-4 pt-4 pb-5">
          <Avatar source={avatarUri} size={80} variant={MEDIA_VARIANT_VIDEO_POSTER} />
          <UserName
            name={profileData.design.displayName ?? profileData.name?.displayName}
            handle={profileData.username}
            verified={profileData.verified}
            isFederated={profileData.isFederated}
            copyableHandle
            variant="default"
            // UserName exposes name/handle sizing only through this typed style
            // object (no 24px `variant`), so the profile header itself sets the
            // display-name scale the same way — matched here for parity.
            style={{
              name: { fontSize: 24, fontWeight: 'bold', marginTop: 12, marginBottom: 4 },
              handle: { fontSize: 15 },
            }}
          />
        </View>

        {/* Account details — dates, location, activity */}
        {hasAccountDetails && (
          <SettingsListGroup title={t('Account details', { defaultValue: 'Account details' })}>
            {joinDate && (
              <SettingsListItem
                icon={<CalendarMonthIcon size={20} className="text-muted-foreground" />}
                title={t('Date joined', { defaultValue: 'Date joined' })}
                value={joinDate}
              />
            )}

            {profileData.primaryLocation && (
              <SettingsListItem
                icon={<RowIcon name="location" />}
                title={t('Account based in', { defaultValue: 'Account based in' })}
                value={profileData.primaryLocation}
              />
            )}

            {hasUsernameChanges && (
              <SettingsListItem
                icon={<RowIcon name="at" />}
                title={t('Username changes', { defaultValue: 'Username changes' })}
                value={String(profileData.usernameChangeCount)}
              />
            )}

            {profileData.connectedVia && (
              <SettingsListItem
                icon={<RowIcon name="globe" />}
                title={t('Connected via', { defaultValue: 'Connected via' })}
                value={profileData.connectedVia}
              />
            )}
          </SettingsListGroup>
        )}

        {/* Verification — its own section, matching the profile's emphasis on the
            verified badge */}
        {profileData.verified && (
          <SettingsListGroup title={t('Verification', { defaultValue: 'Verification' })}>
            <SettingsListItem
              icon={<VerifiedIcon size={20} className="text-primary" />}
              title={t('Verified', { defaultValue: 'Verified' })}
              value={verifiedDate
                ? t('Since {date}', { date: verifiedDate, defaultValue: `Since ${verifiedDate}` })
                : t('Verified account', { defaultValue: 'Verified account' })}
            />
          </SettingsListGroup>
        )}
      </ScrollView>
    </ThemedView>
  );
}
