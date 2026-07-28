import React, { memo } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Platform, ScrollView, Pressable } from 'react-native';
import { Backdrop } from '@oxyhq/bloom/overlay';

import { SHORTCUTS } from '@/hooks/useKeyboardShortcuts';

interface KeyboardShortcutsModalProps {
  visible: boolean;
  onClose: () => void;
}

const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({ visible, onClose }) => {

  if (Platform.OS !== 'web' || !visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      {/* Bloom's shared backdrop — the same blur + dim every dialog, sheet and
          menu uses. This screen used to paint its own flat 50% black. */}
      <Backdrop onPress={onClose} style={styles.overlay}>
        <Pressable
          className="bg-background border-border"
          style={styles.modal}
          onPress={(e) => e.stopPropagation()}
        >
          <View className="border-border" style={styles.header}>
            <Text className="text-foreground" style={styles.title}>Keyboard Shortcuts</Text>
            <TouchableOpacity
              onPress={onClose}
              className="bg-muted"
              style={styles.closeButton}
              accessibilityLabel="Close keyboard shortcuts"
              accessibilityRole="button"
            >
              <Text className="text-muted-foreground" style={styles.closeButtonText}>Esc</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.list}>
            {SHORTCUTS.filter(
              (s, i, arr) =>
                // Deduplicate: skip Ctrl+n since n already shown
                !(s.keys.length === 2 && s.keys[0] === 'Ctrl' && s.keys[1] === 'n')
            ).map((shortcut, index) => (
              <View
                key={index}
                className="border-border"
                style={styles.row}
              >
                <View style={styles.keysContainer}>
                  {shortcut.keys.map((key, ki) => (
                    <React.Fragment key={ki}>
                      {ki > 0 && (
                        <Text className="text-muted-foreground" style={styles.plus}>
                          {shortcut.keys.length === 2 && shortcut.keys[0] === 'g' ? ' then ' : ' + '}
                        </Text>
                      )}
                      <View className="bg-muted border-border" style={styles.key}>
                        <Text className="text-foreground" style={styles.keyText}>{key}</Text>
                      </View>
                    </React.Fragment>
                  ))}
                </View>
                <Text className="text-muted-foreground" style={styles.description}>
                  {shortcut.description}
                </Text>
              </View>
            ))}
          </ScrollView>
        </Pressable>
      </Backdrop>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  modal: {
    width: 400,
    maxWidth: '90%',
    maxHeight: '80%',
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  closeButton: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  closeButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  list: {
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  keysContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  key: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    minWidth: 28,
    alignItems: 'center',
  },
  keyText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  plus: {
    fontSize: 12,
    marginHorizontal: 2,
  },
  description: {
    fontSize: 14,
  },
});

export default memo(KeyboardShortcutsModal);
