import React, { memo, useMemo } from 'react';
import { Platform } from 'react-native';
import type { DialogHeaderConfig } from '@oxy.so/bloom/dialog';
import { Kbd } from '@oxy.so/bloom/kbd';

import { SHORTCUTS } from '@/hooks/useKeyboardShortcuts';

import {
  Dialog as LDialog,
  Embed,
  HStack,
  RawText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface KeyboardShortcutsModalProps {
  visible: boolean;
  onClose: () => void;
}

// Deduplicate: skip Ctrl+n since n is already shown.
const VISIBLE_SHORTCUTS = SHORTCUTS.filter(
  (s) => !(s.keys.length === 2 && s.keys[0] === 'Ctrl' && s.keys[1] === 'n'),
);

const HEADER: DialogHeaderConfig = { title: 'Keyboard Shortcuts', largeTitle: false };

/**
 * The `?` help sheet (web only — native has no hardware-keyboard shortcuts).
 * Bloom's `Dialog` owns the backdrop, the close control and Escape-to-close;
 * each key is a Bloom `Kbd`.
 */
const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({ visible, onClose }) => {
  const rows = useMemo(
    () =>
      VISIBLE_SHORTCUTS.map((shortcut, index) =>
        toElement(
          HStack(
            HStack(
              Embed(
                shortcut.keys.map((key, ki) => (
                  <React.Fragment key={ki}>
                    {ki > 0 &&
                      toElement(
                        RawText(
                          shortcut.keys.length === 2 && shortcut.keys[0] === 'g' ? ' then ' : ' + ',
                        )
                          .margin('horizontal', '2xs')
                          .font('xs')
                          .leading('16px')
                          .foreground('muted'),
                      )}
                    <Kbd>{key}</Kbd>
                  </React.Fragment>
                )),
              ),
            ).align('center'),
            RawText(shortcut.description).font('14').leading('20px').foreground('muted'),
          )
            .padding('vertical', '10')
            .border('border', 'thin', 'bottom')
            .align('center')
            .justify('between'),
          index,
        ),
      ),
    [],
  );

  if (Platform.OS !== 'web') return null;

  return toElement(
    LDialog(
      /* Header mode insets the body below the nav bar but not at the sides. */ VStack(
        Embed(rows),
      ).padding('horizontal', 'xl'),
    )
      .header(HEADER)
      .label('Keyboard shortcuts')
      .frame({ maxWidth: '400' })
      .presented([visible, () => onClose()]),
  );
};

export default memo(KeyboardShortcutsModal);
