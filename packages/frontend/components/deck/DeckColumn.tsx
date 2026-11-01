import { reportBoundaryError } from '@/components/AppErrorBoundary';
import { FeedUpdatePolicyProvider } from '@/components/Feed/FeedUpdatePolicy';
import { useAuth } from '@oxy.so/services/ui/client';
import { Suspense, useState } from 'react';
import { PanelRouterProvider, PanelRouteSlot } from '@oxy.so/bloom/panel-routing';
import { Screen } from '@oxy.so/bloom/screen';
import { FeedSkeleton } from '@/components/loading/ContentSkeleton';
import NotFoundScreen from '@/components/NotFoundScreen';
import { deckRoutes, retryFailedDeckRoutes } from './deckRoutes';
import { PanelErrorBoundary } from '@oxy.so/bloom/error-boundary';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { usePanelNavigation } from '@oxy.so/bloom/app-shell/hooks';
import { Button, IconButton } from '@oxy.so/bloom/button';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { Dialog } from '@oxy.so/bloom/dialog';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Switch } from '@oxy.so/bloom/switch';
import { APP_COLOR_PRESETS, type AppColorName } from '@oxy.so/bloom/theme';
import {
  DECK_SOURCES,
  deckRouteForSource,
  DEFAULT_DECK_SETTINGS,
  useDeckSettings,
  type DeckSource,
} from './deckSettings';
export { DECK_SOURCES } from './deckSettings';
import { SettingsSelect } from '@/components/settings/SettingsSelect';

/** Column actions compose into the current screen header through Bloom. */
export function DeckColumnHeaderActions({ panelId }: { panelId: string }) {
  const { t } = useTranslation();
  const navigation = usePanelNavigation();
  const { canUsePrivateApi } = useAuth();
  const settings = useDeckSettings(
    (state) => state.panels[panelId] ?? DEFAULT_DECK_SETTINGS[panelId],
  );
  const updatePanel = useDeckSettings((state) => state.updatePanel);
  const removePanel = useDeckSettings((state) => state.removePanel);
  const canRemove = useDeckSettings((state) => Object.keys(state.panels).length > 1);
  const resetPanel = useDeckSettings((state) => state.resetPanel);
  const [open, setOpen] = useState(false);
  const source = settings.source;
  const setSource = (name: DeckSource) => {
    updatePanel(panelId, { source: name });
    if (name !== source) {
      setOpen(false);
      navigation.push(deckRouteForSource(name));
    }
  };
  return (
    <>
      <IconButton
        leadingIcon={RiSettings3Line}
        accessibilityLabel={t('deck.settings')}
        onPress={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        label={t('deck.settings')}
        header={{ title: t('deck.settings') }}
        maxWidth={480}
      >
        <View className="px-5 pb-5 gap-5">
          <GroupedSection>
            <GroupedSectionItem
              title={t('deck.source')}
              rightElement={
                <SettingsSelect
                  label={t('deck.source')}
                  value={source}
                  items={DECK_SOURCES.map((value) => ({
                    value,
                    label: t(`deck.sources.${value}`),
                  }))}
                  onChange={setSource}
                />
              }
            />
            <GroupedSectionItem
              title={t('deck.resizable')}
              rightElement={
                <Switch
                  checked={settings.resizable}
                  onCheckedChange={(resizable) => updatePanel(panelId, { resizable })}
                  accessibilityLabel={t('deck.resizable')}
                />
              }
            />
            <GroupedSectionItem
              title={t('deck.appearance')}
              rightElement={
                <SettingsSelect
                  label={t('deck.appearance')}
                  value={settings.appearance}
                  items={[
                    { value: 'solid', label: t('deck.solid') },
                    { value: 'plain', label: t('deck.plain') },
                  ]}
                  onChange={(appearance) => updatePanel(panelId, { appearance })}
                />
              }
            />
            <GroupedSectionItem
              title={t('deck.color')}
              description={t('deck.colorDescription')}
              rightElement={
                <SettingsSelect
                  label={t('deck.color')}
                  value={settings.colorPreset ?? 'inherit'}
                  items={[
                    { value: 'inherit', label: t('deck.inherit') },
                    ...Object.keys(APP_COLOR_PRESETS).map((value) => ({
                      value,
                      label: value.charAt(0).toUpperCase() + value.slice(1),
                    })),
                  ]}
                  onChange={(value) =>
                    updatePanel(panelId, {
                      colorPreset: value === 'inherit' ? undefined : (value as AppColorName),
                    })
                  }
                />
              }
            />
          </GroupedSection>
          {source !== 'saved' && (
            <GroupedSection>
              <GroupedSectionItem
                title={t('deck.liveUpdates', 'Update in real time')}
                description={
                  !canUsePrivateApi
                    ? t('deck.liveRequiresSignIn', 'Sign in to receive live feed updates')
                    : undefined
                }
                rightElement={
                  <Switch
                    checked={settings.liveUpdates ?? false}
                    disabled={!canUsePrivateApi}
                    onCheckedChange={(liveUpdates) => updatePanel(panelId, { liveUpdates })}
                    accessibilityLabel={t('deck.liveUpdates', 'Update in real time')}
                  />
                }
              />
              <GroupedSectionItem
                title={t('deck.pauseWhileReading', 'Pause updates while reading')}
                rightElement={
                  <Switch
                    checked={settings.pauseWhileReading ?? true}
                    onCheckedChange={(pauseWhileReading) =>
                      updatePanel(panelId, { pauseWhileReading })
                    }
                    accessibilityLabel={t('deck.pauseWhileReading', 'Pause updates while reading')}
                  />
                }
              />
            </GroupedSection>
          )}
          <View className="flex-row gap-3">
            <Button
              className="flex-1"
              appearance="outline"
              onPress={() => {
                resetPanel(panelId);
                const source = (DEFAULT_DECK_SETTINGS[panelId] ?? DEFAULT_DECK_SETTINGS['deck-0'])
                  .source;
                navigation.push(deckRouteForSource(source));
              }}
            >
              {t('deck.reset')}
            </Button>
            <Button
              className="flex-1"
              disabled={!canRemove}
              appearance="subtle"
              onPress={() => {
                setOpen(false);
                removePanel(panelId);
              }}
            >
              {t('deck.removePanel', 'Remove panel')}
            </Button>
          </View>
        </View>
      </Dialog>
    </>
  );
}

/** Each column uses Bloom's own viewport and route history. */
export function DeckColumn({ panelId }: { panelId: string }) {
  const settings = useDeckSettings((state) => state.panels[panelId]);
  return (
    <FeedUpdatePolicyProvider
      enabled={settings.liveUpdates ?? false}
      pauseWhileReading={settings.pauseWhileReading ?? true}
    >
      <DeckColumnContent />
    </FeedUpdatePolicyProvider>
  );
}

function DeckColumnContent() {
  const { t } = useTranslation();
  const navigation = usePanelNavigation();
  return (
    <PanelRouterProvider routes={deckRoutes} notFound={<NotFoundScreen />}>
      <PanelErrorBoundary
        onError={reportBoundaryError}
        resetKey={navigation.entry.key}
        emptyState={{ action: { label: t('common.retry'), onPress: retryFailedDeckRoutes } }}
      >
        <Suspense
          fallback={
            <Screen scroll="auto">
              <FeedSkeleton />
            </Screen>
          }
        >
          <PanelRouteSlot />
        </Suspense>
      </PanelErrorBoundary>
    </PanelRouterProvider>
  );
}
