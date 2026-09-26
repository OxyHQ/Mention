import React, { memo, useMemo } from 'react';
import { View, Text, Platform } from 'react-native';
import { Dialog, type DialogHeaderConfig } from '@oxy.so/bloom/dialog';
import { Kbd } from '@oxy.so/bloom/kbd';

import { SHORTCUTS } from '@/hooks/useKeyboardShortcuts';

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
      VISIBLE_SHORTCUTS.map((shortcut, index) => (
        <View
          key={index}
          className="flex-row items-center justify-between border-b border-border py-2.5"
        >
          <View className="flex-row items-center">
            {shortcut.keys.map((key, ki) => (
              <React.Fragment key={ki}>
                {ki > 0 && (
                  <Text className="mx-0.5 text-xs text-muted-foreground">
                    {shortcut.keys.length === 2 && shortcut.keys[0] === 'g' ? ' then ' : ' + '}
                  </Text>
                )}
                <Kbd>{key}</Kbd>
              </React.Fragment>
            ))}
          </View>
          <Text className="text-sm text-muted-foreground">{shortcut.description}</Text>
        </View>
      )),
    [],
  );

  if (Platform.OS !== 'web') return null;

  return (
    <Dialog
      open={visible}
      onClose={onClose}
      header={HEADER}
      label="Keyboard shortcuts"
      maxWidth={400}
    >
      {/* Header mode insets the body below the nav bar but not at the sides. */}
      <View className="px-5">{rows}</View>
    </Dialog>
  );
};

export default memo(KeyboardShortcutsModal);
