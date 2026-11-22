import { SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { useExternalEmbedsStore } from '@/stores/externalEmbedsStore';
import { EXTERNAL_EMBED_SOURCES, externalEmbedLabels } from '@mention/shared-types/externalEmbeds';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import {
  Admonition as LAdmonition,
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  SettingsSection as LSettingsSection,
  Text,
  Toggle,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

export default function ExternalMediaSettingsScreen() {
  const { t } = useTranslation();

  const { isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();

  const prefs = useExternalEmbedsStore((state) => state.prefs);
  const setPref = useExternalEmbedsStore((state) => state.setPref);

  if (!isAuthResolved || isPrivateApiPending) {
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  if (!canUsePrivateApi) {
    return toElement(
      VStack(
        Embed(
          <OxyAuthPrompt
            label={t('settings.externalMedia.signInRequired', {
              defaultValue: 'Sign in to manage external media',
            })}
            description={t('settings.externalMedia.signInRequiredDesc', {
              defaultValue: 'Choose which third-party media players can load inline.',
            })}
          />,
        ),
      ).spacing('lg'),
    );
  }

  return toElement(
    VStack(
      VStack(
        VStack(
          LAdmonition(
            Text(
              t('settings.externalMedia.banner', {
                defaultValue:
                  'External media may allow websites to collect information about you and your device. No information is sent or requested until you press the "play" button.',
              }),
            ),
          ).style('info'),
        )
          .padding('bottom', 'xs')
          .padding('top', 'sm'),
        LSettingsSection(
          t('settings.externalMedia.enableFor', {
            defaultValue: 'Enable media players for',
          }),
          LGroupedSection(
            Embed(
              EXTERNAL_EMBED_SOURCES.map((source) =>
                toElement(
                  LGroupedSectionItem(externalEmbedLabels[source])
                    .wrapControl()
                    .trailing(
                      Embed(
                        <>
                          {toElement(
                            Toggle([
                              prefs[source] === 'show',
                              () => setPref(source, prefs[source] === 'show' ? 'hide' : 'show'),
                            ]),
                          )}
                        </>,
                      ),
                    ),
                  source,
                ),
              ),
            ),
          ),
        ),
      ).spacing('lg'),
    ).spacing('lg'),
  );
}
