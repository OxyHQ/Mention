import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { useViewerSettingsSection } from '@/hooks/useViewerSettings';
import { logger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { Embed, VStack, toElement } from '@oxy.so/bloom-language';
import {
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
} from '@oxy.so/bloom-language/containers';
import { Toggle } from '@oxy.so/bloom-language/inputs';
import { SettingsSection as LSettingsSection } from '@oxy.so/bloom-language/settings';

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
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  if (!canUsePrivateApi) {
    return toElement(
      VStack(
        Embed(
          <OxyAuthPrompt
            label={t('settings.privacy.tagsMentions.signInRequired', {
              defaultValue: 'Sign in to manage tags and mentions',
            })}
            description={t('settings.privacy.tagsMentions.signInRequiredDesc', {
              defaultValue: 'Control who can tag or mention you in posts.',
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
            LGroupedSectionItem(t('settings.privacy.allowTags'))
              .wrapControl()
              .description(t('settings.privacy.allowTagsDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([allowTags, (value) => updateSetting('allowTags', value)]).label(
                        t('settings.privacy.allowTags'),
                      ),
                    )}
                  </>,
                ),
              ),
            LGroupedSectionItem(t('settings.privacy.allowMentions'))
              .wrapControl()
              .description(t('settings.privacy.allowMentionsDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([
                        allowMentions,
                        (value) => updateSetting('allowMentions', value),
                      ]).label(t('settings.privacy.allowMentions')),
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
