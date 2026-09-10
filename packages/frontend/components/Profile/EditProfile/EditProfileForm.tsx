import React, { useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Loading } from '@oxy.so/bloom/loading';
import { SettingsListDivider } from '@oxy.so/bloom/settings-list';
import { useBloomTheme, useTheme } from '@oxy.so/bloom/theme';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@/components/ui/Button';
import { ColorSwatchPicker } from '@/components/settings/ColorSwatchPicker';
import { useProfileData } from '@/hooks/useProfileData';
import { entitledColorNames } from '@/lib/colorEntitlement';
import { Icon } from '@/lib/icons';
import { useAppColorSave } from '@/hooks/useAppColorSave';
import { BannerSection } from './BannerSection';
import { PinnedMediaSection } from './PinnedMediaSection';

/**
 * The one Edit Profile form, shared by the navigable route and the profile
 * dialog. Presentation chrome belongs to those two hosts; reads, writes and
 * validation stay here so opening the sheet cannot fork a second editor.
 */
export function EditProfileForm() {
  const { t } = useTranslation();
  const { isAuthenticated, showBottomSheet, user: authUser } = useAuth();
  const { data: currentUserProfile } = useProfileData(authUser?.username);
  const { colorPreset: appColor } = useBloomTheme();
  const { colors } = useTheme();
  const { saveColor } = useAppColorSave();

  const authUserRecord = authUser as { premium?: { isPremium?: boolean } } | null;
  const isPremium = authUserRecord?.premium?.isPremium ?? false;
  const visibleColors = useMemo(
    () => entitledColorNames({ username: authUser?.username, isPremium }),
    [authUser?.username, isPremium],
  );

  if (!isAuthenticated) {
    return (
      <OxyAuthPrompt
        label={t('settings.editProfile.signInRequired')}
        description={t('settings.editProfile.signInRequiredDesc')}
      />
    );
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="pb-6"
      showsVerticalScrollIndicator={false}
    >
      {currentUserProfile ? (
        <View className="items-center pb-5 gap-1">
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
      <View className="px-5 py-4 gap-3">
        <View className="flex-row items-center gap-3">
          <Icon name="color-palette" size={22} color={colors.text} />
          <Text className="text-[16px] text-foreground">
            {t('settings.accentColor', 'Accent color')}
          </Text>
        </View>
        <ColorSwatchPicker value={appColor} onChange={saveColor} colors={visibleColors} />
      </View>
      <SettingsListDivider />
      <PinnedMediaSection />
    </ScrollView>
  );
}
