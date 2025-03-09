/**
 * BottomSheetContainer Component
 * 
 * Container component that renders the bottom sheet modal.
 * This component should be rendered at the root of the app.
 * 
 * Example usage of the session switcher:
 * 
 * ```jsx
 * import { BottomSheetContext } from '@/context/BottomSheetContext';
 * import { SessionSwitcher } from '@/modules/oxyhqservices/components/SessionSwitcher';
 * 
 * // In your component:
 * const { setBottomSheetContent, openBottomSheet } = useContext(BottomSheetContext);
 * 
 * const handleOpenSessionSwitcher = () => {
 *   setBottomSheetContent(<SessionSwitcher onClose={() => openBottomSheet(false)} />);
 *   openBottomSheet(true);
 * };
 * 
 * // Then in your JSX:
 * <Button onPress={handleOpenSessionSwitcher} title="Switch Account" />
 * ```
 */

import React, { useContext, useState, useEffect, ReactNode } from 'react';
import { Modal, View, StyleSheet, TouchableWithoutFeedback } from 'react-native';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { colors } from '../../styles/colors';
import { SessionSwitcher } from '../SessionSwitcher';
import { AuthBottomSheet } from '../AuthBottomSheet';

// Create a simple event emitter for bottom sheet state
export const bottomSheetState = {
  isOpen: false,
  content: null as ReactNode,
  listeners: [] as Array<() => void>,

  setOpen(open: boolean) {
    this.isOpen = open;
    this.notifyListeners();
  },

  setContent(content: ReactNode) {
    this.content = content;
    this.notifyListeners();
  },

  subscribe(listener: () => void) {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  },

  notifyListeners() {
    this.listeners.forEach(listener => listener());
  },

  // Helper function to open the session switcher
  openSessionSwitcher() {
    try {
      this.setContent(
        <SessionSwitcher
          onClose={() => {
            this.setOpen(false);
            this.setContent(null);
          }}
        />
      );
      this.setOpen(true);
    } catch (error) {
      console.error('Error opening session switcher:', error);
    }
  },

  // Helper function to open the auth bottom sheet
  openAuthBottomSheet(initialMode: 'signin' | 'signup' = 'signin', onSuccess?: () => void) {
    try {
      this.setContent(
        <AuthBottomSheet
          initialMode={initialMode}
          onSuccess={() => {
            if (onSuccess) onSuccess();
            // Don't automatically close the bottom sheet on success
            // The AuthBottomSheet will handle this
          }}
        />
      );
      this.setOpen(true);
    } catch (error) {
      console.error('Error opening auth bottom sheet:', error);
    }
  }
};

export function BottomSheetContainer() {
  const { openBottomSheet } = useContext(BottomSheetContext);
  const [isOpen, setIsOpen] = useState(bottomSheetState.isOpen);
  const [content, setContent] = useState<ReactNode>(bottomSheetState.content);

  // Subscribe to bottom sheet state changes
  useEffect(() => {
    const unsubscribe = bottomSheetState.subscribe(() => {
      setIsOpen(bottomSheetState.isOpen);
      setContent(bottomSheetState.content);
    });

    return unsubscribe;
  }, []);

  const handleBackdropPress = () => {
    bottomSheetState.setOpen(false);
    openBottomSheet(false);
  };

  return (
    <Modal
      visible={isOpen}
      transparent
      animationType="slide"
      onRequestClose={handleBackdropPress}
    >
      <TouchableWithoutFeedback onPress={handleBackdropPress}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.contentContainer}>
              {content}
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  contentContainer: {
    backgroundColor: colors.primaryLight,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    maxHeight: '80%',
  },
});