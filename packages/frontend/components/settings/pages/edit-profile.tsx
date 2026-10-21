import { useOxyIdentityRows } from '@/components/settings/useOxyIdentityRows';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { BannerSection } from '@/components/Profile/EditProfile/BannerSection';
import { PinnedMediaSection } from '@/components/Profile/EditProfile/PinnedMediaSection';
import { useAppColorSave } from '@/hooks/useAppColorSave';
import { useMentionColorViewer } from '@/hooks/useMentionColorViewer';
import { entitledColorNames } from '@/lib/colorEntitlement';
import { Button } from '@oxy.so/bloom/button';
import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
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
  const { colorPreset } = useBloomTheme();
  const { saveColor } = useAppColorSave();
  const identityRows = useOxyIdentityRows({ full: true });
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

  return (
    <View className="gap-4">
      <SettingsGeneralPage
        sections={[
          {
            key: 'identity',
            rows: [
              ...identityRows,
              {
                key: 'manage',
                label: t('settings.editProfile.oxyAccount', { defaultValue: 'Oxy account' }),
                description: t('settings.account.oxyDescription', {
                  defaultValue: 'Manage your shared Oxy identity, profile and security.',
                }),
                control: (
                  <Button
                    size="sm"
                    appearance="subtle"
                    tone="neutral"
                    onPress={() => showBottomSheet?.('ManageAccount')}
                  >
                    {t('settings.account.manageYourAccount', {
                      defaultValue: 'Manage your account',
                    })}
                  </Button>
                ),
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
