import { useOxyIdentityRows } from '@/components/settings/useOxyIdentityRows';
import { SettingsSelect } from '@oxy.so/bloom/settings-modal/rows';
import { BannerSection } from '@/components/Profile/EditProfile/BannerSection';
import { PinnedMediaSection } from '@/components/Profile/EditProfile/PinnedMediaSection';
import { markPresetSelection } from '@/hooks/useAccountTheme';
import { useMentionColorViewer } from '@/hooks/useMentionColorViewer';
import { isColorEntitled } from '@/lib/colorEntitlement';
import { logger } from '@oxy.so/core/logger';
import { Button } from '@oxy.so/bloom/button';
import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
import { COLOR_PRESET_REGISTRY, type AppColorName } from '@oxy.so/bloom/theme';
import { OxyAuthPrompt, useAccountColorSave, useAuth } from '@oxy.so/services/ui/client';
import { useCallback, useMemo } from 'react';
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
  const identityRows = useOxyIdentityRows({ full: true });
  const viewer = useMentionColorViewer();
  // The colour is the Oxy account colour: it is saved through the SDK, which
  // keeps the Bloom theme and the account in step. Mention adds only its
  // paywall, the same rule `useAccountThemeSync` applies.
  const canUse = useCallback((name: AppColorName) => isColorEntitled(name, viewer), [viewer]);
  const { colors, value, saveColor } = useAccountColorSave({ canUse });
  const colorItems = useMemo(() => {
    const allowed = new Set<string>(colors);
    return COLOR_PRESET_REGISTRY.filter(({ name }) => allowed.has(name)).map(
      ({ name, displayName }) => ({ value: name, label: displayName }),
    );
  }, [colors]);
  const chooseColor = useCallback(
    (name: AppColorName) => {
      markPresetSelection();
      saveColor(name).catch((error: unknown) => logger.error('Error updating color', error));
    },
    [saveColor],
  );

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
                    value={value}
                    onChange={chooseColor}
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
