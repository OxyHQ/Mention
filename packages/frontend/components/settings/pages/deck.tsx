import { useDeckAvailable } from '@/components/deck/useDeckAvailable';
import { useDeckSettings } from '@/components/deck/deckSettings';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { Text, type TextStyle } from 'react-native';
import { tokens } from '@oxy.so/bloom/styles';
import { useColorTokens } from '@oxy.so/bloom/theme';

import {
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  SettingsSection as LSettingsSection,
  Toggle,
  toElement,
} from '@oxy.so/bloom-language';

/** Where the workspace is saved, under its settings (`text-sm px-4`). */
const STATUS = {
  fontSize: 14,
  lineHeight: 20,
  paddingHorizontal: tokens.space.lg,
} satisfies TextStyle;

export default function DeckSettingsPage() {
  const { t } = useTranslation();
  const colorTokens = useColorTokens();
  const available = useDeckAvailable();
  const homeScreen = useDeckSettings((state) => state.homeScreen === true);
  const setHomeScreen = useDeckSettings((state) => state.setHomeScreen);
  const { user, canUsePrivateApi } = useAuth();
  const syncEnabled = useDeckSettings((state) => state.syncEnabled);
  const setSyncEnabled = useDeckSettings((state) => state.setSyncEnabled);
  const status = useDeckSettings((state) => state.status);
  return toElement(
    LSettingsSection(
      t('deck.workspace.title', 'Deck'),
      LGroupedSection(
        Embed(
          available &&
            toElement(
              LGroupedSectionItem(t('deck.workspace.homeScreen'))
                .wrapControl()
                .description(t('deck.workspace.homeScreenDescription'))
                .trailing(
                  Embed(
                    <>
                      {toElement(
                        Toggle([homeScreen, setHomeScreen]).label(t('deck.workspace.homeScreen')),
                      )}
                    </>,
                  ),
                ),
            ),
        ),
        LGroupedSectionItem(t('deck.workspace.sync', 'Sync across devices'))
          .wrapControl()
          .description(
            t(
              'deck.workspace.description',
              'Save your panels, pages, navigation history and reading positions to your account.',
            ),
          )
          .trailing(
            Embed(
              <>
                {toElement(
                  Toggle([syncEnabled, setSyncEnabled])
                    .disabled(!canUsePrivateApi)
                    .label(t('deck.workspace.sync', 'Sync across devices')),
                )}
              </>,
            ),
          ),
      ),
      Embed(
        // A live region, which the language's text has no modifier for.
        <Text
          style={[STATUS, { color: colorTokens.mutedForeground }]}
          accessibilityLiveRegion="polite"
        >
          {!user?.id
            ? t(
                'deck.workspace.anonymous',
                'Sign in to sync your Deck. Your workspace is saved on this device.',
              )
            : status === 'error'
              ? t(
                  'deck.workspace.error',
                  'Changes are saved on this device. Sync could not finish and will retry automatically.',
                )
              : !syncEnabled
                ? t(
                    'deck.workspace.local',
                    'Your workspace stays on this device. Turn sync on to share this workspace with your other devices.',
                  )
                : status === 'saved'
                  ? t('deck.workspace.saved', 'Your Deck is saved to your account.')
                  : t(
                      'deck.workspace.saving',
                      'Your workspace is available immediately. Saving to your account…',
                    )}
        </Text>,
      ),
    ),
  );
}
