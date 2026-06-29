import React, { useCallback } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Dialog, type DialogControlProps } from '@oxyhq/bloom/dialog';
import { Admonition } from '@oxyhq/bloom/admonition';
import { Button } from '@oxyhq/bloom/button';
import {
  EXTERNAL_EMBED_SOURCES,
  externalEmbedLabels,
  type EmbedPlayerSource,
  type ExternalEmbedsSettings,
} from '@mention/shared-types';
import { useExternalEmbedsStore } from '@/stores/externalEmbedsStore';

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
      <View className="gap-4">
        <Text className="text-base leading-snug text-foreground">
          {t('settings.externalMedia.consentBody', {
            source: label,
            defaultValue: `This content is hosted by ${label}. Do you want to enable external media?`,
          })}
        </Text>

        <Admonition type="info">
          {t('settings.externalMedia.banner', {
            defaultValue:
              'External media may allow websites to collect information about you and your device. No information is sent or requested until you press the "play" button.',
          })}
        </Admonition>

        <View className="gap-3">
          <Button variant="primary" size="large" onPress={onShowAll}>
            {t('settings.externalMedia.enableAll', { defaultValue: 'Enable external media' })}
          </Button>
          <Button variant="secondary" size="large" onPress={onShowOne}>
            {t('settings.externalMedia.enableOne', {
              source: label,
              defaultValue: `Enable ${label} only`,
            })}
          </Button>
          <Button variant="ghost" size="large" onPress={onHide}>
            {t('settings.externalMedia.noThanks', { defaultValue: 'No thanks' })}
          </Button>
        </View>
      </View>
    </Dialog>
  );
}
