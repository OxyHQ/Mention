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
    <ThemedView style={{ flex: 1, paddingTop: insets.top }}>
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
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
      >
        {/* Profile Header */}
        <View style={styles.profileHeader}>
          <View style={styles.avatarContainer}>
            <Avatar
              source={avatarSource}
              size={56}
              verified={profileData?.verified}
            />
          </View>
          <View style={styles.profileHeaderText}>
            <View style={styles.nameRow}>
              <ThemedText style={[styles.displayName, { color: theme.colors.text }]}>
                {displayName}
              </ThemedText>
              {profileData?.verified && (
                <Ionicons name="checkmark-circle" size={20} color={theme.colors.primary} />
              )}
            </View>
            <ThemedText style={[styles.username, { color: theme.colors.textSecondary }]}>
              @{profileData?.username || cleanUsername}
            </ThemedText>
          </View>
        </View>

        {/* Account Details List */}
        <View style={[styles.detailsContainer, { backgroundColor: theme.colors.card }]}>
          {/* Date Joined */}
          {profileData?.createdAt && (
            <View style={[styles.detailRow, styles.firstRow, { borderBottomColor: theme.colors.border }]}>
              <View style={[styles.detailIcon, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="calendar-outline" size={18} color={theme.colors.textSecondary} />
              </View>
              <View style={styles.detailContent}>
                <ThemedText style={[styles.detailLabel, { color: theme.colors.text }]}>
                  {t('Date joined', { defaultValue: 'Date joined' })}
                </ThemedText>
                <ThemedText style={[styles.detailValue, { color: theme.colors.textSecondary }]}>
                  {joinDate}
                </ThemedText>
              </View>
            </View>
          )}

          {/* Account Based In */}
          {profileData?.primaryLocation && (
            <View style={[styles.detailRow, { borderBottomColor: theme.colors.border }]}>
              <View style={[styles.detailIcon, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="location-outline" size={18} color={theme.colors.textSecondary} />
              </View>
              <View style={styles.detailContent}>
                <ThemedText style={[styles.detailLabel, { color: theme.colors.text }]}>
                  {t('Account based in', { defaultValue: 'Account based in' })}
                </ThemedText>
                <ThemedText style={[styles.detailValue, { color: theme.colors.textSecondary }]}>
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
              <View style={[styles.detailIcon, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="checkmark-circle-outline" size={18} color={theme.colors.textSecondary} />
              </View>
              <View style={styles.detailContent}>
                <ThemedText style={[styles.detailLabel, { color: theme.colors.text }]}>
                  {t('Verified', { defaultValue: 'Verified' })}
                </ThemedText>
                <ThemedText style={[styles.detailValue, { color: theme.colors.textSecondary }]}>
                  {verifiedDate ? t('Since {date}', { date: verifiedDate, defaultValue: `Since ${verifiedDate}` }) : t('Verified account', { defaultValue: 'Verified account' })}
                </ThemedText>
              </View>
              <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          )}

          {/* Username Changes */}
          <View style={[styles.detailRow, { borderBottomColor: theme.colors.border }]}>
            <View style={[styles.detailIcon, { backgroundColor: theme.colors.backgroundSecondary }]}>
              <Ionicons name="at-outline" size={18} color={theme.colors.textSecondary} />
            </View>
            <View style={styles.detailContent}>
              <ThemedText style={[styles.detailLabel, { color: theme.colors.text }]}>
                {t('Username changes', { defaultValue: 'Username changes' })}
              </ThemedText>
              <ThemedText style={[styles.detailValue, { color: theme.colors.textSecondary }]}>
                {profileData?.usernameChangeCount ?? 0}
              </ThemedText>
            </View>
          </View>

          {/* Connected Via - could be expanded later with app store info */}
          {profileData?.connectedVia && (
            <View style={[styles.detailRow, styles.lastRow]}>
              <View style={[styles.detailIcon, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="globe-outline" size={18} color={theme.colors.textSecondary} />
              </View>
              <View style={styles.detailContent}>
                <ThemedText style={[styles.detailLabel, { color: theme.colors.text }]}>
                  {t('Connected via', { defaultValue: 'Connected via' })}
                </ThemedText>
                <ThemedText style={[styles.detailValue, { color: theme.colors.textSecondary }]}>
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
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 20,
  },
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    gap: 12,
    overflow: 'visible',
  },
  avatarContainer: {
    position: 'relative',
    overflow: 'visible',
  },
  profileHeaderText: {
    flex: 1,
    gap: 4,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  displayName: {
    fontSize: 18,
    fontWeight: '700',
  },
  username: {
    fontSize: 15,
  },
  detailsContainer: {
    borderRadius: 16,
    overflow: 'hidden',
  },
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
  detailIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailContent: {
    flex: 1,
    gap: 2,
  },
  detailLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  detailValue: {
    fontSize: 13,
  },
});

