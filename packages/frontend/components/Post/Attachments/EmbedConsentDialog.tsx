import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, type DialogControlProps } from '@oxy.so/bloom/dialog';
import {
  EXTERNAL_EMBED_SOURCES,
  externalEmbedLabels,
  type EmbedPlayerSource,
  type ExternalEmbedsSettings,
} from '@mention/shared-types/externalEmbeds';
import { useExternalEmbedsStore } from '@/stores/externalEmbedsStore';

import {
  Admonition as LAdmonition,
  Button as LButton,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface EmbedConsentDialogProps {
  control: DialogControlProps;
  source: EmbedPlayerSource;
  /** Called after the viewer opts in (this source or all) so playback can start. */
  onAccept: () => void;
}

/**
 * First-play consent for an external media player, mirroring Bluesky's
 * EmbedConsent. Lets the viewer enable all providers, just this provider, or
 * decline (which hides this provider's player going forward). Choices persist
 * through the external-embeds store.
 */
export function EmbedConsentDialog({ control, source, onAccept }: EmbedConsentDialogProps) {
  const { t } = useTranslation();
  const setPref = useExternalEmbedsStore((state) => state.setPref);
  const setManyPrefs = useExternalEmbedsStore((state) => state.setManyPrefs);
  const label = externalEmbedLabels[source];

  const onShowAll = useCallback(() => {
    const patch: ExternalEmbedsSettings = {};
    for (const key of EXTERNAL_EMBED_SOURCES) {
      patch[key] = 'show';
    }
    void setManyPrefs(patch);
    onAccept();
    control.close();
  }, [control, onAccept, setManyPrefs]);

  const onShowOne = useCallback(() => {
    void setPref(source, 'show');
    onAccept();
    control.close();
  }, [control, onAccept, setPref, source]);

  const onHide = useCallback(() => {
    void setPref(source, 'hide');
    control.close();
  }, [control, setPref, source]);

  const title = t('settings.externalMedia.consentTitle', { defaultValue: 'External Media' });

  return (
    <Dialog control={control} title={title} label={title}>
      {toElement(
        VStack(
          RawText(
            t('settings.externalMedia.consentBody', {
              source: label,
              defaultValue: `This content is hosted by ${label}. Do you want to enable external media?`,
            }),
          )
            .font('16')
            .leading('easy')
            .foreground('foreground'),
          LAdmonition(
            LText(
              t('settings.externalMedia.banner', {
                defaultValue:
                  'External media may allow websites to collect information about you and your device. No information is sent or requested until you press the "play" button.',
              }),
            ),
          ).style('info'),
          VStack(
            LButton(
              LText(
                t('settings.externalMedia.enableAll', { defaultValue: 'Enable external media' }),
              ),
            )
              .style('solid')
              .tint('accent')
              .size('lg')
              .onPress(onShowAll),
            LButton(
              LText(
                t('settings.externalMedia.enableOne', {
                  source: label,
                  defaultValue: `Enable ${label} only`,
                }),
              ),
            )
              .style('subtle')
              .tint('neutral')
              .size('lg')
              .onPress(onShowOne),
            LButton(LText(t('settings.externalMedia.noThanks', { defaultValue: 'No thanks' })))
              .style('plain')
              .tint('neutral')
              .size('lg')
              .onPress(onHide),
          ).spacing('md'),
        ).spacing('lg'),
      )}
    </Dialog>
  );
}
