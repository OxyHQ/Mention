import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import Avatar from '@/components/Avatar';
import { Link, useLocalSearchParams, router } from 'expo-router';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { Ionicons } from '@expo/vector-icons';
import { useProfileData } from '@/hooks/useProfileData';

export default function AccountInfoScreen() {
  const insets = useSafeAreaInsets();
  const { username } = useLocalSearchParams<{ username: string }>();
  const cleanUsername = username?.startsWith('@') ? username.slice(1) : username || '';
  const { t } = useTranslation();
  const theme = useTheme();
  // Use unified profile data hook - automatically fetches profile and appearance settings
  const { data: profileData, loading: profileLoading } = useProfileData(cleanUsername);

  const avatarSource = profileData?.design?.avatar || profileData?.avatar;

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

  const displayName = useMemo(() => (
    profileData?.design?.displayName ||
    profileData?.username ||
    cleanUsername
  ), [profileData, cleanUsername]);

  return (
    <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
      <Header
        options={{
          title: t('About', { defaultValue: 'About' }),
          leftComponents: [
            <IconButton
              key="back"
              variant="icon"
              onPress={() => router.back()}
            >
              <BackArrowIcon size={20} color={theme.colors.text} />
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
              source={avatarSource}
              size={56}
              verified={profileData?.verified}
            />
          </View>
          <View className="flex-1 gap-1">
            <View className="flex-row items-center gap-1.5">
              <ThemedText className="text-lg font-bold text-foreground">
                {displayName}
              </ThemedText>
              {profileData?.verified && (
                <Ionicons name="checkmark-circle" size={20} color={theme.colors.primary} />
              )}
            </View>
            <ThemedText className="text-[15px] text-muted-foreground">
              @{profileData?.username || cleanUsername}
            </ThemedText>
          </View>
        </View>

        {/* Account Details List */}
        <View className="rounded-2xl overflow-hidden bg-card">
          {/* Date Joined */}
          {profileData?.createdAt && (
            <View style={[styles.detailRow, styles.firstRow, { borderBottomColor: theme.colors.border }]}>
              <View className="w-8 h-8 rounded-full items-center justify-center bg-secondary">
                <Ionicons name="calendar-outline" size={18} color={theme.colors.textSecondary} />
              </View>
              <View className="flex-1 gap-0.5">
                <ThemedText className="text-sm font-semibold text-foreground">
                  {t('Date joined', { defaultValue: 'Date joined' })}
                </ThemedText>
                <ThemedText className="text-[13px] text-muted-foreground">
                  {joinDate}
                </ThemedText>
              </View>
            </View>
          )}

          {/* Account Based In */}
          {profileData?.primaryLocation && (
            <View style={[styles.detailRow, { borderBottomColor: theme.colors.border }]}>
              <View className="w-8 h-8 rounded-full items-center justify-center bg-secondary">
                <Ionicons name="location-outline" size={18} color={theme.colors.textSecondary} />
              </View>
              <View className="flex-1 gap-0.5">
                <ThemedText className="text-sm font-semibold text-foreground">
                  {t('Account based in', { defaultValue: 'Account based in' })}
                </ThemedText>
                <ThemedText className="text-[13px] text-muted-foreground">
                  {profileData.primaryLocation}
                </ThemedText>
              </View>
            </View>
          )}

          {/* Verified */}
          {profileData?.verified && (
            <TouchableOpacity
              style={[styles.detailRow, { borderBottomColor: theme.colors.border }]}
              activeOpacity={0.7}
            >
              <View className="w-8 h-8 rounded-full items-center justify-center bg-secondary">
                <Ionicons name="checkmark-circle-outline" size={18} color={theme.colors.textSecondary} />
              </View>
              <View className="flex-1 gap-0.5">
                <ThemedText className="text-sm font-semibold text-foreground">
                  {t('Verified', { defaultValue: 'Verified' })}
                </ThemedText>
                <ThemedText className="text-[13px] text-muted-foreground">
                  {verifiedDate ? t('Since {date}', { date: verifiedDate, defaultValue: `Since ${verifiedDate}` }) : t('Verified account', { defaultValue: 'Verified account' })}
                </ThemedText>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          )}

          {/* Username Changes */}
          <View style={[styles.detailRow, { borderBottomColor: theme.colors.border }]}>
            <View className="w-8 h-8 rounded-full items-center justify-center bg-secondary">
              <Ionicons name="at-outline" size={18} color={theme.colors.textSecondary} />
            </View>
            <View className="flex-1 gap-0.5">
              <ThemedText className="text-sm font-semibold text-foreground">
                {t('Username changes', { defaultValue: 'Username changes' })}
              </ThemedText>
              <ThemedText className="text-[13px] text-muted-foreground">
                {profileData?.usernameChangeCount ?? 0}
              </ThemedText>
            </View>
          </View>

          {/* Connected Via - could be expanded later with app store info */}
          {profileData?.connectedVia && (
            <View style={[styles.detailRow, styles.lastRow]}>
              <View className="w-8 h-8 rounded-full items-center justify-center bg-secondary">
                <Ionicons name="globe-outline" size={18} color={theme.colors.textSecondary} />
              </View>
              <View className="flex-1 gap-0.5">
                <ThemedText className="text-sm font-semibold text-foreground">
                  {t('Connected via', { defaultValue: 'Connected via' })}
                </ThemedText>
                <ThemedText className="text-[13px] text-muted-foreground">
                  {profileData.connectedVia}
                </ThemedText>
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  firstRow: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  lastRow: {
    borderBottomWidth: 0,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
});
