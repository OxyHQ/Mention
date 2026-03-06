import React, { memo } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Platform, ScrollView, Pressable } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { SHORTCUTS } from '@/hooks/useKeyboardShortcuts';

interface KeyboardShortcutsModalProps {
  visible: boolean;
  onClose: () => void;
}

const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({ visible, onClose }) => {
  const theme = useTheme();

  if (Platform.OS !== 'web' || !visible) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable
          style={[styles.modal, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
            <Text style={[styles.title, { color: theme.colors.text }]}>Keyboard Shortcuts</Text>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.closeButton, { backgroundColor: theme.colors.backgroundSecondary }]}
              accessibilityLabel="Close keyboard shortcuts"
              accessibilityRole="button"
            >
              <Text style={[styles.closeButtonText, { color: theme.colors.textSecondary }]}>Esc</Text>
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
                style={[styles.row, { borderBottomColor: theme.colors.border }]}
              >
                <View style={styles.keysContainer}>
                  {shortcut.keys.map((key, ki) => (
                    <React.Fragment key={ki}>
                      {ki > 0 && (
                        <Text style={[styles.plus, { color: theme.colors.textSecondary }]}>
                          {shortcut.keys.length === 2 && shortcut.keys[0] === 'g' ? ' then ' : ' + '}
                        </Text>
                      )}
                      <View style={[styles.key, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border }]}>
                        <Text style={[styles.keyText, { color: theme.colors.text }]}>{key}</Text>
                      </View>
                    </React.Fragment>
                  ))}
                </View>
                <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
                  {shortcut.description}
                </Text>
              </View>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
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
