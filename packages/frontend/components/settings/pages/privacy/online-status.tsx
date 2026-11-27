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
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  if (!canUsePrivateApi) {
    return toElement(
      VStack(
        Embed(
          <OxyAuthPrompt
            label={t('settings.privacy.onlineStatus.signInRequired', {
              defaultValue: 'Sign in to manage your online status',
            })}
            description={t('settings.privacy.onlineStatus.signInRequiredDesc', {
              defaultValue: 'Decide whether others see when you are online.',
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
            LGroupedSectionItem(t('settings.privacy.showOnlineStatus'))
              .wrapControl()
              .description(t('settings.privacy.showOnlineStatusDesc'))
              .trailing(
                Embed(
                  <>
                    {toElement(
                      Toggle([showOnlineStatus, updateSetting]).label(
                        t('settings.privacy.showOnlineStatus'),
                      ),
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
