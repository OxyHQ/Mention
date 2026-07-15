import React, { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services';
import { useBloomTheme, useTheme, PREMIUM_COLOR_NAMES, type AppColorName } from '@oxyhq/bloom/theme';
import { SettingsListDivider } from '@oxyhq/bloom/settings-list';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { Button, IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useProfileData } from '@/hooks/useProfileData';
import { ColorSwatchPicker } from '@/components/settings/ColorSwatchPicker';
import { Icon } from '@/lib/icons';
import { useAppColorSave } from '@/hooks/useAppColorSave';
import { BannerSection } from '@/components/Profile/EditProfile/BannerSection';
import { ProfileStyleSection } from '@/components/Profile/EditProfile/ProfileStyleSection';
import { PinnedMediaSection } from '@/components/Profile/EditProfile/PinnedMediaSection';

export default function EditProfileScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { isAuthenticated, showBottomSheet, user: authUser } = useAuth();
  const { data: currentUserProfile } = useProfileData(authUser?.username);
  const { colorPreset: appColor } = useBloomTheme();
  const { colors } = useTheme();
  const { saveColor } = useAppColorSave();

  const normalizedUsername = authUser?.username?.toLowerCase();
  const authUserRecord = authUser as { premium?: { isPremium?: boolean } } | null;
  const isPremium = authUserRecord?.premium?.isPremium ?? false;
  const isOxyUser = normalizedUsername === 'oxy';
  const isFaircoinUser = normalizedUsername === 'faircoin';

  // Reproduces `appearance.tsx`'s premium-color-unlock logic verbatim: full
  // premium palette for premium users, else only the colors tied to a
  // username-gated preset (@oxy unlocks "oxy", @faircoin unlocks "faircoin").
  const unlockedPremiumColors = useMemo<readonly AppColorName[] | undefined>(() => {
    if (isPremium) return PREMIUM_COLOR_NAMES;
    const unlocked: AppColorName[] = [];
    if (isOxyUser) unlocked.push('oxy');
    if (isFaircoinUser) unlocked.push('faircoin');
    return unlocked.length > 0 ? unlocked : undefined;
  }, [isPremium, isOxyUser, isFaircoinUser]);

  if (!isAuthenticated) {
    return (
      <ThemedView className="flex-1">
        <Header
          options={{
            title: t('profile.editProfile'),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <OxyAuthPrompt
          label={t('settings.editProfile.signInRequired')}
          description={t('settings.editProfile.signInRequiredDesc')}
        />
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('profile.editProfile'),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder
        disableSticky
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="py-4"
        showsVerticalScrollIndicator={false}
      >
        {currentUserProfile ? (
          <View className="items-center py-4 gap-1">
            <Avatar source={currentUserProfile.avatar} size={80} />
            <Text className="text-2xl font-bold text-foreground mt-2" numberOfLines={1}>
              {currentUserProfile.design.displayName}
            </Text>
            <Text className="text-base text-muted-foreground" numberOfLines={1}>
              @{currentUserProfile.username}
            </Text>
            <View className="mt-3">
              <Button
                variant="secondary"
                size="small"
                onPress={() => showBottomSheet?.('ManageAccount')}
              >
                {t('settings.account.manageAccount', { defaultValue: 'Manage account' })}
              </Button>
            </View>
          </View>
        ) : (
          <View className="items-center py-4">
            <Loading />
          </View>
        )}
        <SettingsListDivider />
        <BannerSection />
        <SettingsListDivider />
        <ProfileStyleSection />
        <SettingsListDivider />
        <View className="px-5 py-3 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="color-palette" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">{t('settings.accentColor', 'Accent color')}</Text>
          </View>
          <ColorSwatchPicker value={appColor} onChange={saveColor} extraColors={unlockedPremiumColors} />
        </View>
        <SettingsListDivider />
        <PinnedMediaSection />
      </ScrollView>
    </ThemedView>
  );
}
