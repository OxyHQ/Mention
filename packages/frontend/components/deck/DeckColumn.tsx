import { PostEngagementProvider } from '@/components/Post/PostEngagementProvider';
import { reportBoundaryError } from '@/components/AppRootErrorBoundary';
import { FeedUpdatePolicyProvider } from '@/components/Feed/FeedUpdatePolicy';
import { useAuth } from '@oxy.so/services/ui/client';
import { Suspense, useState } from 'react';
import { PanelRouterProvider, PanelRouteSlot } from '@oxy.so/bloom/panel-routing';
import { Screen } from '@oxy.so/bloom/screen';
import { FeedSkeleton } from '@/components/loading/ContentSkeleton';
import NotFoundScreen from '@/components/NotFoundScreen';
import { deckRoutes, retryFailedDeckRoutes } from './deckRoutes';
import { PanelErrorBoundary } from '@oxy.so/bloom/error-boundary';
import { useTranslation } from 'react-i18next';
import { usePanelNavigation } from '@oxy.so/bloom/app-shell/hooks';
import { RiSettings3Line } from '@oxy.so/bloom/icons/RiSettings3Line';
import { APP_COLOR_PRESETS, type AppColorName } from '@oxy.so/bloom/theme';
import {
  DECK_SOURCES,
  deckRouteForSource,
  DEFAULT_DECK_SETTINGS,
  useDeckSettings,
  type DeckSource,
} from './deckSettings';
import {
  Button as LButton,
  Dialog as LDialog,
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  HStack,
  Icon,
  SettingsSelect as LSettingsSelect,
  Text,
  Toggle,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

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
  const liveUpdatesRow = LGroupedSectionItem(t('deck.liveUpdates', 'Update in real time')).trailing(
    Toggle([settings.liveUpdates ?? false, (liveUpdates) => updatePanel(panelId, { liveUpdates })])
      .disabled(!canUsePrivateApi)
      .label(t('deck.liveUpdates', 'Update in real time')),
  );
  return (
    <>
      {toElement(
        LButton(Icon(RiSettings3Line))
          .shape('circle')
          .style('outline')
          .tint('neutral')
          .label(t('deck.settings'))
          .onPress(() => setOpen(true)),
      )}
      {toElement(
        LDialog(
          VStack(
            LGroupedSection(
              LGroupedSectionItem(t('deck.source')).trailing(
                LSettingsSelect(
                  t('deck.source'),
                  [source, setSource],
                  DECK_SOURCES.map((value) => ({
                    value,
                    label: t(`deck.sources.${value}`),
                  })),
                ),
              ),
              navigation.entry.name.split(/[?#]/)[0] !== '/videos'
                ? LGroupedSectionItem(t('deck.resizable')).trailing(
                    Toggle([
                      settings.resizable,
                      (resizable) => updatePanel(panelId, { resizable }),
                    ]).label(t('deck.resizable')),
                  )
                : null,
              LGroupedSectionItem(t('deck.appearance')).trailing(
                LSettingsSelect(
                  t('deck.appearance'),
                  [settings.appearance, (appearance) => updatePanel(panelId, { appearance })],
                  [
                    { value: 'solid', label: t('deck.solid') },
                    { value: 'plain', label: t('deck.plain') },
                  ],
                ),
              ),
              LGroupedSectionItem(t('deck.color'))
                .description(t('deck.colorDescription'))
                .trailing(
                  LSettingsSelect(
                    t('deck.color'),
                    [
                      settings.colorPreset ?? 'inherit',
                      (value) =>
                        updatePanel(panelId, {
                          colorPreset: value === 'inherit' ? undefined : (value as AppColorName),
                        }),
                    ],
                    [
                      { value: 'inherit', label: t('deck.inherit') },
                      ...Object.keys(APP_COLOR_PRESETS).map((value) => ({
                        value,
                        label: value.charAt(0).toUpperCase() + value.slice(1),
                      })),
                    ],
                  ),
                ),
            ),
            source !== 'saved'
              ? LGroupedSection(
                  // Signed out, the row says why live updates are off.
                  canUsePrivateApi
                    ? liveUpdatesRow
                    : liveUpdatesRow.description(
                        t('deck.liveRequiresSignIn', 'Sign in to receive live feed updates'),
                      ),
                  LGroupedSectionItem(
                    t('deck.pauseWhileReading', 'Pause updates while reading'),
                  ).trailing(
                    Toggle([
                      settings.pauseWhileReading ?? true,
                      (pauseWhileReading) => updatePanel(panelId, { pauseWhileReading }),
                    ]).label(t('deck.pauseWhileReading', 'Pause updates while reading')),
                  ),
                )
              : null,
            HStack(
              LButton(Text(t('deck.reset')))
                .style('outline')
                .flex('1')
                .onPress(() => {
                  resetPanel(panelId);
                  const source = (DEFAULT_DECK_SETTINGS[panelId] ?? DEFAULT_DECK_SETTINGS['deck-0'])
                    .source;
                  navigation.push(deckRouteForSource(source));
                }),
              LButton(Text(t('deck.removePanel', 'Remove panel')))
                .style('subtle')
                .flex('1')
                .disabled(!canRemove)
                .onPress(() => {
                  setOpen(false);
                  removePanel(panelId);
                }),
            ).spacing('md'),
          )
            .padding('horizontal', 'xl')
            .padding('bottom', 'xl')
            .spacing('xl'),
        )
          .label(t('deck.settings'))
          .header({ title: t('deck.settings') })
          .frame({ maxWidth: '480' })
          .presented([open, () => setOpen(false)]),
      )}
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
      <PostEngagementProvider>
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
      </PostEngagementProvider>
    </PanelRouterProvider>
  );
}
