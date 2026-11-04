import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { useViewerSettingsSection } from '@/lib/viewerSettings';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { Switch } from '@oxy.so/bloom/switch';
import { logger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

export default function TagsMentionsScreen() {
  const { t } = useTranslation();

  const { isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();
  const { value: privacy, isLoading: loading, update } = useViewerSettingsSection('privacy');
  const allowTags = privacy.allowTags !== false;
  const allowMentions = privacy.allowMentions !== false;

  const updateSetting = (field: 'allowTags' | 'allowMentions', value: boolean) => {
    update({ [field]: value }).catch((error: unknown) => {
      logger.error('Error updating setting', error);
    });
  };

  if (!isAuthResolved || isPrivateApiPending) {
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
          label={t('settings.privacy.tagsMentions.signInRequired', {
            defaultValue: 'Sign in to manage tags and mentions',
          })}
          description={t('settings.privacy.tagsMentions.signInRequiredDesc', {
            defaultValue: 'Control who can tag or mention you in posts.',
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
              label={t('settings.privacy.allowTags')}
              description={t('settings.privacy.allowTagsDesc')}
            >
              {
                <Switch
                  checked={allowTags}
                  onCheckedChange={(value) => updateSetting('allowTags', value)}
                  accessibilityLabel={t('settings.privacy.allowTags')}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t('settings.privacy.allowMentions')}
              description={t('settings.privacy.allowMentionsDesc')}
            >
              {
                <Switch
                  checked={allowMentions}
                  onCheckedChange={(value) => updateSetting('allowMentions', value)}
                  accessibilityLabel={t('settings.privacy.allowMentions')}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
