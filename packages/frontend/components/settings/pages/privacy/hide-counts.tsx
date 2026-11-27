import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { useViewerSettingsSection } from '@/hooks/useViewerSettings';
import { createLogger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import {
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  SettingsSection as LSettingsSection,
  Toggle,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

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
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  if (!canUsePrivateApi) {
    return toElement(
      VStack(
        Embed(
          <OxyAuthPrompt
            label={t('settings.privacy.hideCounts.signInRequired', {
              defaultValue: 'Sign in to hide engagement counts',
            })}
            description={t('settings.privacy.hideCounts.signInRequiredDesc', {
              defaultValue: 'Hide likes, boosts, replies, and saves on your posts.',
            })}
          />,
        ),
      ).spacing('lg'),
    );
  }

  if (loading) {
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  return toElement(
    VStack(
      VStack(
        LSettingsSection(
          undefined,
          LGroupedSection(
            LGroupedSectionItem(t('settings.privacy.hideAllCounts'))
              .wrapControl()
              .description(t('settings.privacy.hideAllCountsDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([allHidden, (value) => updateAllSettings(value)]).label(
                        t('settings.privacy.hideAllCounts'),
                      ),
                    )}
                  </>,
                ),
              ),
          ),
        ),
        LSettingsSection(
          t('settings.privacy.individualSettings'),
          LGroupedSection(
            LGroupedSectionItem(t('settings.privacy.hideLikeCounts'))
              .wrapControl()
              .description(t('settings.privacy.hideLikeCountsDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([
                        hideLikeCounts,
                        (value) => updateSetting('hideLikeCounts', value),
                      ]).label(t('settings.privacy.hideLikeCounts')),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(t('settings.privacy.hideShareCounts'))
              .wrapControl()
              .description(t('settings.privacy.hideShareCountsDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([
                        hideShareCounts,
                        (value) => updateSetting('hideShareCounts', value),
                      ]).label(t('settings.privacy.hideShareCounts')),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(t('settings.privacy.hideReplyCounts'))
              .wrapControl()
              .description(t('settings.privacy.hideReplyCountsDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([
                        hideReplyCounts,
                        (value) => updateSetting('hideReplyCounts', value),
                      ]).label(t('settings.privacy.hideReplyCounts')),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(t('settings.privacy.hideSaveCounts'))
              .wrapControl()
              .description(t('settings.privacy.hideSaveCountsDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([
                        hideSaveCounts,
                        (value) => updateSetting('hideSaveCounts', value),
                      ]).label(t('settings.privacy.hideSaveCounts')),
                    )}
                  </>,
                ),
              ),
          ),
        ),
      ).spacing('lg'),
    ).spacing('lg'),
  );
}
