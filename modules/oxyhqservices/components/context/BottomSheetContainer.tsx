/**
 * BottomSheetContainer Component
 * 
 * Container component that renders the bottom sheet modal.
 * This component should be rendered at the root of the app.
 */

import React, { useContext } from 'react';
import { Modal, View, StyleSheet, TouchableWithoutFeedback } from 'react-native';
import { BottomSheetContext } from './BottomSheetContext';
import { colors } from '../../styles/colors';

export function BottomSheetContainer() {
  const { isOpen, content, openBottomSheet } = useContext(BottomSheetContext);

  const handleBackdropPress = () => {
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
    minHeight: 200,
    maxHeight: '90%',
  },
});