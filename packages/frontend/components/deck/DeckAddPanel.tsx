import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RiInsertColumnRight } from '@oxy.so/bloom/icons/RiInsertColumnRight';
import { DECK_SOURCES, useDeckSettings, type DeckSource } from './deckSettings';

import {
  Button as LButton,
  Dialog as LDialog,
  Icon,
  SettingsSelect as LSettingsSelect,
  Text,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

export function DeckAddPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<DeckSource>('explore');
  const addPanel = useDeckSettings((state) => state.addPanel);
  return (
    <>
      {toElement(
        LButton(Icon(RiInsertColumnRight))
          .shape('circle')
          .style('outline')
          .tint('neutral')
          .label(t('deck.addPanel', 'Add panel'))
          .onPress(() => setOpen(true)),
      )}
      {toElement(
        LDialog(
          VStack(
            LSettingsSelect(
              t('deck.source'),
              [source, setSource],
              DECK_SOURCES.map((value) => ({ value, label: t(`deck.sources.${value}`) })),
            ),
            LButton(Text(t('deck.addPanel', 'Add panel'))).onPress(() => {
              addPanel(source);
              setOpen(false);
            }),
          )
            .padding('all', 'xl')
            .spacing('xl'),
        )
          .label(t('deck.addPanel', 'Add panel'))
          .header({ title: t('deck.addPanel', 'Add panel') })
          .frame({ maxWidth: '480' })
          .presented([open, () => setOpen(false)]),
      )}
    </>
  );
}
