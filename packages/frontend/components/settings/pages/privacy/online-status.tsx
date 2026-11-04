import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { useViewerSettingsSection } from '@/lib/viewerSettings';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { Switch } from '@oxy.so/bloom/switch';
import { logger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

export default function OnlineStatusScreen() {
  const { t } = useTranslation();

  const { canUsePrivateApi, isPrivateApiPending } = useAuth();
  const { value: privacy, isLoading: loading, update } = useViewerSettingsSection('privacy');
  const showOnlineStatus = privacy.showOnlineStatus !== false;

  const updateSetting = (value: boolean) => {
    update({ showOnlineStatus: value }).catch((error: unknown) => {
      logger.error('Error updating setting', error);
    });
  };

  if (isPrivateApiPending) {
    return (
      <View className="gap-4">
        <SettingsSkeleton />
      </View>
    );
  }

  if (!canUsePrivateApi) {
    return (
      <View className="gap-4">
        <OxyAuthPrompt
          label={t('settings.privacy.onlineStatus.signInRequired', {
            defaultValue: 'Sign in to manage your online status',
          })}
          description={t('settings.privacy.onlineStatus.signInRequiredDesc', {
            defaultValue: 'Decide whether others see when you are online.',
          })}
        />
      </View>
    );
  }

  if (loading) {
    return (
      <View className="gap-4">
        <SettingsSkeleton />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <View className="gap-4">
        <SettingsSection>
          <SettingsCard>
            <SettingsRow
              label={t('settings.privacy.showOnlineStatus')}
              description={t('settings.privacy.showOnlineStatusDesc')}
            >
              {
                <Switch
                  checked={showOnlineStatus}
                  onCheckedChange={updateSetting}
                  accessibilityLabel={t('settings.privacy.showOnlineStatus')}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
