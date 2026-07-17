import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useAppearanceStore, type PostTextExpand, type PostReadMoreAction } from '@/store/appearanceStore';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { ThemedView } from '@/components/ThemedView';
import { useTheme, useBloomTheme } from '@oxyhq/bloom/theme';
import { Loading } from '@oxyhq/bloom/loading';
import { useTranslation } from 'react-i18next';
import { SegmentedControl, SegmentedControlItem, SegmentedControlItemText } from '@oxyhq/bloom/segmented-control';
import { SettingsListDivider, SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { Icon } from '@/lib/icons';
import { Toggle } from '@/components/Toggle';
import { RowIcon } from '@/components/settings/RowIcon';
import { useThemeControls } from '@/hooks/useAccountTheme';

type ThemeMode = 'system' | 'light' | 'dark';

export default function AppearanceSettingsScreen() {
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const { mode: bloomMode } = useBloomTheme();
  const { source, changeThemeSource, changeThemeMode } = useThemeControls();
  const safeBack = useSafeBack();
  const { colors } = useTheme();
  const { t } = useTranslation();

  const themeMode: ThemeMode = bloomMode === 'adaptive' || bloomMode === 'system'
    ? 'system'
    : bloomMode;
  const postTextExpand: PostTextExpand = mySettings?.appearance?.postTextExpand ?? 'default';
  const postReadMoreAction: PostReadMoreAction = mySettings?.appearance?.postReadMoreAction ?? 'openPost';
  const collapseLongBio: boolean = mySettings?.appearance?.collapseLongBio ?? true;
  const [settingsSaving, setSettingsSaving] = useState(false);

  const saveSettings = useCallback(async (updates: {
    postTextExpand?: PostTextExpand;
    postReadMoreAction?: PostReadMoreAction;
    collapseLongBio?: boolean;
  }) => {
    setSettingsSaving(true);
    const expand = updates.postTextExpand ?? postTextExpand;
    const readMoreAction = updates.postReadMoreAction ?? postReadMoreAction;
    const collapseBio = updates.collapseLongBio ?? collapseLongBio;
    await updateMySettings({
      appearance: {
        postTextExpand: expand,
        postReadMoreAction: readMoreAction,
        collapseLongBio: collapseBio,
      },
    });
    setSettingsSaving(false);
  }, [postTextExpand, postReadMoreAction, collapseLongBio, updateMySettings]);

  // Color mode is owned by the theme bridge: it updates Bloom immediately and,
  // when the theme source is `account`, writes back to the Oxy account theme.
  const onThemeModeChange = useCallback((mode: ThemeMode) => {
    setSettingsSaving(true);
    void changeThemeMode(mode).finally(() => setSettingsSaving(false));
  }, [changeThemeMode]);

  const onPostTextExpandChange = useCallback((value: PostTextExpand) => {
    void saveSettings({ postTextExpand: value });
  }, [saveSettings]);

  const onPostReadMoreActionChange = useCallback((value: PostReadMoreAction) => {
    void saveSettings({ postReadMoreAction: value });
  }, [saveSettings]);

  const onCollapseLongBioChange = useCallback((value: 'collapse' | 'full') => {
    void saveSettings({ collapseLongBio: value === 'collapse' });
  }, [saveSettings]);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.appearance', 'Appearance'),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: settingsSaving ? [
            <View key="saving" className="pr-2">
              <Loading className="text-primary" variant="inline" size="small" />
            </View>,
          ] : [],
        }}
        hideBottomBorder
        disableSticky
      />

      <ScrollView
        className="flex-1"
        contentContainerClassName="py-4"
        showsVerticalScrollIndicator={false}
      >
        {/* Theme source: portable account theme vs. a device-local app theme */}
        <SettingsListGroup
          footer={t(
            'settings.theme.source.footer',
            'When on, your color mode and accent are saved to your Oxy account and shared across Oxy apps. When off, this device keeps its own theme.',
          )}
        >
          <SettingsListItem
            icon={<RowIcon name="cloud-outline" />}
            title={t('settings.theme.source.useAccount', 'Sync theme with account')}
            description={t('settings.theme.source.useAccountDesc', 'Use your Oxy account theme on this device')}
            showChevron={false}
            rightElement={
              <Toggle
                value={source === 'account'}
                onValueChange={(on) => changeThemeSource(on ? 'account' : 'app')}
              />
            }
          />
        </SettingsListGroup>

        <SettingsListDivider />

        {/* Color mode */}
        <View className="px-5 py-3 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="phone-portrait" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.theme', 'Color mode')}
            </Text>
          </View>
          <SegmentedControl
            label={t('settings.theme', 'Color mode')}
            type="radio"
            value={themeMode}
            onChange={onThemeModeChange}>
            <SegmentedControlItem value="system">
              <SegmentedControlItemText>{t('settings.theme.system', 'System')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="light">
              <SegmentedControlItemText>{t('settings.theme.light', 'Light')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="dark">
              <SegmentedControlItemText>{t('settings.theme.dark', 'Dark')}</SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </View>

        <SettingsListDivider />

        {/* Post text length */}
        <View className="px-5 py-3 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="text-outline" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.appearance.postTextLength', 'Post text length')}
            </Text>
          </View>
          <SegmentedControl
            label={t('settings.appearance.postTextLength', 'Post text length')}
            type="radio"
            value={postTextExpand}
            onChange={onPostTextExpandChange}>
            <SegmentedControlItem value="default">
              <SegmentedControlItemText>{t('settings.appearance.postTextLength.default', 'Default')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="more">
              <SegmentedControlItemText>{t('settings.appearance.postTextLength.more', 'More')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="muchMore">
              <SegmentedControlItemText>{t('settings.appearance.postTextLength.muchMore', 'Much more')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="all">
              <SegmentedControlItemText>{t('settings.appearance.postTextLength.all', 'Show all')}</SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </View>

        <SettingsListDivider />

        {/* Read more tap behavior */}
        <View className="px-5 py-3 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="expand-outline" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.appearance.readMoreAction', 'On "Read more" tap')}
            </Text>
          </View>
          <SegmentedControl
            label={t('settings.appearance.readMoreAction', 'On "Read more" tap')}
            type="radio"
            value={postReadMoreAction}
            onChange={onPostReadMoreActionChange}>
            <SegmentedControlItem value="openPost">
              <SegmentedControlItemText>{t('settings.appearance.readMoreAction.openPost', 'Open post')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="expandInline">
              <SegmentedControlItemText>{t('settings.appearance.readMoreAction.expandInline', 'Expand here')}</SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </View>

        <SettingsListDivider />

        {/* Profile bio collapse */}
        <View className="px-5 py-3 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="reader-outline" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.appearance.collapseBio', 'Profile bios')}
            </Text>
          </View>
          <SegmentedControl
            label={t('settings.appearance.collapseBio', 'Profile bios')}
            type="radio"
            value={collapseLongBio ? 'collapse' : 'full'}
            onChange={onCollapseLongBioChange}>
            <SegmentedControlItem value="collapse">
              <SegmentedControlItemText>{t('settings.appearance.collapseBio.collapse', 'Collapse if long')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="full">
              <SegmentedControlItemText>{t('settings.appearance.collapseBio.full', 'Always show full')}</SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </View>
      </ScrollView>
    </ThemedView>
  );
}
