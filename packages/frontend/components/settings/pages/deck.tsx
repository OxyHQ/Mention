import { useDeckSettings } from '@/components/deck/deckSettings';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { Switch } from '@oxy.so/bloom/switch';
import { useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { Text } from 'react-native';

export default function DeckSettingsPage() {
  const { t } = useTranslation();
  const { user, canUsePrivateApi } = useAuth();
  const syncEnabled = useDeckSettings((state) => state.syncEnabled);
  const setSyncEnabled = useDeckSettings((state) => state.setSyncEnabled);
  const status = useDeckSettings((state) => state.status);
  return (
    <SettingsSection label={t('deck.workspace.title', 'Deck')}>
      <SettingsCard>
        <SettingsRow
          label={t('deck.workspace.sync', 'Sync across devices')}
          description={t(
            'deck.workspace.description',
            'Save your panels, pages, navigation history and reading positions to your account.',
          )}
          children={
            <Switch
              checked={syncEnabled}
              disabled={!canUsePrivateApi}
              onCheckedChange={setSyncEnabled}
              accessibilityLabel={t('deck.workspace.sync', 'Sync across devices')}
            />
          }
        />
      </SettingsCard>
      <Text className="text-muted-foreground text-sm px-4" accessibilityLiveRegion="polite">
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
      </Text>
    </SettingsSection>
  );
}
