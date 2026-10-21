import { useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Button, IconButton } from '@oxy.so/bloom/button';
import { AddPanelIcon } from '@/assets/icons/add-panel-icon';
import { SettingsSelect } from '@/components/settings/SettingsSelect';
import { DECK_SOURCES, useDeckSettings, type DeckSource } from './deckSettings';

export function DeckAddPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<DeckSource>('explore');
  const addPanel = useDeckSettings((state) => state.addPanel);
  return (
    <>
      <IconButton
        leadingIcon={AddPanelIcon}
        accessibilityLabel={t('deck.addPanel', 'Add panel')}
        onPress={() => setOpen(true)}
      />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        label={t('deck.addPanel', 'Add panel')}
        header={{ title: t('deck.addPanel', 'Add panel') }}
        maxWidth={480}
      >
        <View className="p-5 gap-5">
          <SettingsSelect
            label={t('deck.source')}
            value={source}
            items={DECK_SOURCES.map((value) => ({ value, label: t(`deck.sources.${value}`) }))}
            onChange={setSource}
          />
          <Button
            onPress={() => {
              addPanel(source);
              setOpen(false);
            }}
          >
            {t('deck.addPanel', 'Add panel')}
          </Button>
        </View>
      </Dialog>
    </>
  );
}
