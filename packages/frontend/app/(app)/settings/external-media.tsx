import React from 'react';
import { View, ScrollView } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { Switch } from '@oxyhq/bloom/switch';
import { Admonition } from '@oxyhq/bloom/admonition';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useTranslation } from 'react-i18next';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services';
import { EXTERNAL_EMBED_SOURCES, externalEmbedLabels } from '@mention/shared-types';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
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
    <Header
      options={{
        title,
        leftComponents: [
          <IconButton variant="icon" key="back" onPress={() => safeBack()}>
            <BackArrowIcon size={20} className="text-foreground" />
          </IconButton>,
        ],
      }}
      hideBottomBorder
      disableSticky
    />
  );

  if (!isAuthResolved || isPrivateApiPending) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading />
        </View>
      </ThemedView>
    );
  }

  if (!canUsePrivateApi) {
    return (
      <ThemedView className="flex-1">
        {header}
        <OxyAuthPrompt
          label={t('settings.externalMedia.signInRequired', {
            defaultValue: 'Sign in to manage external media',
          })}
          description={t('settings.externalMedia.signInRequiredDesc', {
            defaultValue: 'Choose which third-party media players can load inline.',
          })}
        />
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      {header}

      <ScrollView className="flex-1" contentContainerClassName="py-2" showsVerticalScrollIndicator={false}>
        <View className="px-4 pb-1 pt-2">
          <Admonition type="info">
            {t('settings.externalMedia.banner', {
              defaultValue:
                'External media may allow websites to collect information about you and your device. No information is sent or requested until you press the "play" button.',
            })}
          </Admonition>
        </View>

        <SettingsListGroup title={t('settings.externalMedia.enableFor', { defaultValue: 'Enable media players for' })}>
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
    </ThemedView>
  );
}
