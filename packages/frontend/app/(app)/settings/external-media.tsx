import React from 'react';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { View, ScrollView } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import { Switch } from '@oxy.so/bloom/switch';
import { Admonition } from '@oxy.so/bloom/admonition';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { useTranslation } from 'react-i18next';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import {
  EXTERNAL_EMBED_SOURCES,
  externalEmbedLabels,
} from '@mention/shared-types/externalEmbeds';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useExternalEmbedsStore } from '@/stores/externalEmbedsStore';

export default function ExternalMediaSettingsScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();

  const prefs = useExternalEmbedsStore((state) => state.prefs);
  const setPref = useExternalEmbedsStore((state) => state.setPref);

  const title = t('settings.externalMedia.title', { defaultValue: 'External Media Preferences' });

  const header = (
    <PageHeader title={title} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />
  );

  if (!isAuthResolved || isPrivateApiPending) {
    return (
      <View className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading />
        </View>
      </View>
    );
  }

  if (!canUsePrivateApi) {
    return (
      <View className="flex-1">
        {header}
        <OxyAuthPrompt
          label={t('settings.externalMedia.signInRequired', {
            defaultValue: 'Sign in to manage external media',
          })}
          description={t('settings.externalMedia.signInRequiredDesc', {
            defaultValue: 'Choose which third-party media players can load inline.',
          })}
        />
      </View>
    );
  }

  return (
    <View className="flex-1">
      {header}

      <ScrollView className="flex-1" contentContainerClassName="px-screen-margin py-2" showsVerticalScrollIndicator={false}>
        <View className="pb-1 pt-2">
          <Admonition type="info">
            {t('settings.externalMedia.banner', {
              defaultValue:
                'External media may allow websites to collect information about you and your device. No information is sent or requested until you press the "play" button.',
            })}
          </Admonition>
        </View>

        <SettingsListGroup variant="filled" title={t('settings.externalMedia.enableFor', { defaultValue: 'Enable media players for' })}>
          {EXTERNAL_EMBED_SOURCES.map((source) => (
            <SettingsListItem
              key={source}
              title={externalEmbedLabels[source]}
              showChevron={false}
              rightElement={
                <Switch
                  value={prefs[source] === 'show'}
                  onValueChange={() => setPref(source, prefs[source] === 'show' ? 'hide' : 'show')}
                />
              }
            />
          ))}
        </SettingsListGroup>
      </ScrollView>
    </View>
  );
}
