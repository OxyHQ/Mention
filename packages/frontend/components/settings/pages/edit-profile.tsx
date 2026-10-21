import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { BannerSection } from '@/components/Profile/EditProfile/BannerSection';
import { PinnedMediaSection } from '@/components/Profile/EditProfile/PinnedMediaSection';
import { useMentionSettings } from '@/context/MentionSettingsContext';
import { useAppColorSave } from '@/hooks/useAppColorSave';
import { useMentionColorViewer } from '@/hooks/useMentionColorViewer';
import { useProfileData } from '@/hooks/useProfileData';
import { entitledColorNames } from '@/lib/colorEntitlement';
import { MEDIA_VARIANT_AVATAR_LG } from '@mention/shared-types/post';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { SettingsGeneralPage, SettingsValueField } from '@oxy.so/bloom/settings-modal';
import { COLOR_PRESET_REGISTRY, useBloomTheme } from '@oxy.so/bloom/theme';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

/**
 * Mention's own profile settings. Identity (photo, name, bio, location, links)
 * belongs to the shared Oxy account, so those rows open Oxy's editor instead of
 * growing a second one here.
 */
export default function EditProfileSettingsPage() {
  const { t } = useTranslation();
  const { isAuthenticated, showBottomSheet, user } = useAuth();
  const { data: profile } = useProfileData(user?.username);
  const { colorPreset } = useBloomTheme();
  const { saveColor } = useAppColorSave();
  const { afterClose } = useMentionSettings();
  const viewer = useMentionColorViewer();
  const colorItems = useMemo(() => {
    const allowed = new Set<string>(entitledColorNames(viewer));
    return COLOR_PRESET_REGISTRY.filter(({ name }) => allowed.has(name)).map(
      ({ name, displayName }) => ({ value: name, label: displayName }),
    );
  }, [viewer]);

  if (!isAuthenticated)
    return (
      <OxyAuthPrompt
        label={t('settings.editProfile.signInRequired')}
        description={t('settings.editProfile.signInRequiredDesc')}
      />
    );

  const editInOxy = (
    <Button
      size="sm"
      appearance="subtle"
      tone="neutral"
      onPress={() => afterClose(() => showBottomSheet?.('EditProfile'))}
    >
      {t('common.edit', { defaultValue: 'Edit' })}
    </Button>
  );

  return (
    <View className="gap-4">
      <SettingsGeneralPage
        sections={[
          {
            key: 'identity',
            rows: [
              {
                key: 'avatar',
                label: t('settings.profile.photo', { defaultValue: 'Profile photo' }),
                control: (
                  <Avatar
                    source={profile?.avatar}
                    name={profile?.design.displayName ?? profile?.username}
                    size={40}
                    variant={MEDIA_VARIANT_AVATAR_LG}
                  />
                ),
              },
              {
                key: 'name',
                label: t('settings.profile.name', { defaultValue: 'Name' }),
                control: <SettingsValueField>{profile?.design.displayName}</SettingsValueField>,
              },
              {
                key: 'handle',
                label: t('settings.profile.username', { defaultValue: 'Username' }),
                control: <SettingsValueField>@{profile?.username}</SettingsValueField>,
              },
              {
                key: 'oxy',
                label: t('settings.editProfile.oxyRow', {
                  defaultValue: 'Photo, name, bio, location and links',
                }),
                description: t('settings.account.oxyDescription', {
                  defaultValue: 'Manage your shared Oxy identity, profile and security.',
                }),
                control: editInOxy,
              },
            ],
          },
          {
            key: 'look',
            label: t('settings.editProfile.look', { defaultValue: 'Look' }),
            rows: [
              {
                key: 'color',
                label: t('settings.accentColor', 'Accent color'),
                control: (
                  <SettingsSelect
                    label={t('settings.accentColor', 'Accent color')}
                    value={colorPreset}
                    onChange={(name) => void saveColor(name)}
                    items={colorItems}
                  />
                ),
              },
            ],
          },
        ]}
      />
      <BannerSection />
      <PinnedMediaSection />
    </View>
  );
}
