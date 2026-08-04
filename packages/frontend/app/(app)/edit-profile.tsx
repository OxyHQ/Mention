import React, { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services/ui/client';
import { useBloomTheme, useTheme } from '@oxyhq/bloom/theme';
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
import { entitledColorNames } from '@/lib/colorEntitlement';
import { Icon } from '@/lib/icons';
import { useAppColorSave } from '@/hooks/useAppColorSave';
import { BannerSection } from '@/components/Profile/EditProfile/BannerSection';
import { PinnedMediaSection } from '@/components/Profile/EditProfile/PinnedMediaSection';

export default function EditProfileScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { isAuthenticated, showBottomSheet, user: authUser } = useAuth();
  const { data: currentUserProfile } = useProfileData(authUser?.username);
  const { colorPreset: appColor } = useBloomTheme();
  const { colors } = useTheme();
  const { saveColor } = useAppColorSave();

  const authUserRecord = authUser as { premium?: { isPremium?: boolean } } | null;
  const isPremium = authUserRecord?.premium?.isPremium ?? false;

  // Which presets this viewer may pick — answered by the one authority that also
  // guards an already-stored preference, so the picker and the applier cannot
  // disagree about who is entitled to what.
  const visibleColors = useMemo(
    () => entitledColorNames({ username: authUser?.username, isPremium }),
    [authUser?.username, isPremium],
  )

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
        <View className="px-5 py-3 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="color-palette" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">{t('settings.accentColor', 'Accent color')}</Text>
          </View>
          <ColorSwatchPicker value={appColor} onChange={saveColor} colors={visibleColors} />
        </View>
        <SettingsListDivider />
        <PinnedMediaSection />
      </ScrollView>
    </ThemedView>
  );
}
