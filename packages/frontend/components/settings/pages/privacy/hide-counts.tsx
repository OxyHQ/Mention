import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { useViewerSettingsSection } from '@/hooks/useViewerSettings';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { Switch } from '@oxy.so/bloom/switch';
import { createLogger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

const hideCountsLogger = createLogger('HideCounts');

type CountField = 'hideLikeCounts' | 'hideShareCounts' | 'hideReplyCounts' | 'hideSaveCounts';

export default function HideCountsScreen() {
  const { t } = useTranslation();

  const { canUsePrivateApi, isPrivateApiPending } = useAuth();
  const { value: privacy, isLoading: loading, update } = useViewerSettingsSection('privacy');
  const hideLikeCounts = privacy.hideLikeCounts === true;
  const hideShareCounts = privacy.hideShareCounts === true;
  const hideReplyCounts = privacy.hideReplyCounts === true;
  const hideSaveCounts = privacy.hideSaveCounts === true;

  const allHidden = hideLikeCounts && hideShareCounts && hideReplyCounts && hideSaveCounts;

  const updateSetting = (field: CountField, value: boolean) => {
    update({ [field]: value }).catch((error: unknown) => {
      hideCountsLogger.error('Error updating setting', error);
    });
  };

  const updateAllSettings = (value: boolean) => {
    update({
      hideLikeCounts: value,
      hideShareCounts: value,
      hideReplyCounts: value,
      hideSaveCounts: value,
    }).catch((error: unknown) => {
      hideCountsLogger.error('Error updating all settings', error);
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
          label={t('settings.privacy.hideCounts.signInRequired', {
            defaultValue: 'Sign in to hide engagement counts',
          })}
          description={t('settings.privacy.hideCounts.signInRequiredDesc', {
            defaultValue: 'Hide likes, boosts, replies, and saves on your posts.',
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
              label={t('settings.privacy.hideAllCounts')}
              description={t('settings.privacy.hideAllCountsDesc')}
            >
              {
                <Switch
                  checked={allHidden}
                  onCheckedChange={(value) => updateAllSettings(value)}
                  accessibilityLabel={t('settings.privacy.hideAllCounts')}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection label={t('settings.privacy.individualSettings')}>
          <SettingsCard>
            <SettingsRow
              label={t('settings.privacy.hideLikeCounts')}
              description={t('settings.privacy.hideLikeCountsDesc')}
            >
              {
                <Switch
                  checked={hideLikeCounts}
                  onCheckedChange={(value) => updateSetting('hideLikeCounts', value)}
                  accessibilityLabel={t('settings.privacy.hideLikeCounts')}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t('settings.privacy.hideShareCounts')}
              description={t('settings.privacy.hideShareCountsDesc')}
            >
              {
                <Switch
                  checked={hideShareCounts}
                  onCheckedChange={(value) => updateSetting('hideShareCounts', value)}
                  accessibilityLabel={t('settings.privacy.hideShareCounts')}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t('settings.privacy.hideReplyCounts')}
              description={t('settings.privacy.hideReplyCountsDesc')}
            >
              {
                <Switch
                  checked={hideReplyCounts}
                  onCheckedChange={(value) => updateSetting('hideReplyCounts', value)}
                  accessibilityLabel={t('settings.privacy.hideReplyCounts')}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t('settings.privacy.hideSaveCounts')}
              description={t('settings.privacy.hideSaveCountsDesc')}
            >
              {
                <Switch
                  checked={hideSaveCounts}
                  onCheckedChange={(value) => updateSetting('hideSaveCounts', value)}
                  accessibilityLabel={t('settings.privacy.hideSaveCounts')}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
