/**
 * BaseBottomSheet Component
 * 
 * A reusable bottom sheet component that serves as the foundation for all modal sheets
 * in the application. Provides consistent styling, header with title/logo, and navigation options.
 */

import React, { ReactNode } from 'react';
import { View, TouchableOpacity, StyleSheet, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { OxyLogo } from '../OxyLogo';
import { ThemedText } from '../ui/ThemedText';
import { colors } from '../../styles/colors';

/**
 * Props for the BaseBottomSheet component
 */
interface BaseBottomSheetProps {
  /** Content to display inside the bottom sheet */
  children: ReactNode;
  /** Optional title text to display in the header */
  title?: string;
  /** Whether to show the OxyLogo in the header (default: true) */
  showLogo?: boolean;
  /** Function called when the close button is pressed */
  onClose: () => void;
  /** Whether to show a back button instead of close button */
  showBackButton?: boolean;
  /** Function called when the back button is pressed */
  onBack?: () => void;
  /** Optional component to render in the right section of the header */
  rightComponent?: ReactNode;
  /** Optional custom styles to apply to the content container */
  contentStyle?: ViewStyle;
}

export function BaseBottomSheet({
  children,
  title,
  showLogo = true,
  onClose,
  showBackButton,
  onBack,
  rightComponent,
  contentStyle,
}: BaseBottomSheetProps) {
  const handleClose = () => {
    if (onClose) {
      onClose();
    }
  };

  const handleBack = () => {
    if (onBack) {
      onBack();
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {showBackButton ? (
            <TouchableOpacity
              onPress={handleBack}
              style={styles.closeButton}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <Ionicons name="arrow-back" size={24} color={colors.primaryColor} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={handleClose}
              style={styles.closeButton}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Ionicons name="close" size={24} color={colors.primaryColor} />
            </TouchableOpacity>
          )}
        </View>
        <View style={styles.headerCenter}>
          {showLogo ? (
            <OxyLogo size={53} style={styles.logo} />
          ) : title ? (
            <ThemedText style={styles.title}>{title}</ThemedText>
          ) : null}
        </View>
        <View style={styles.headerRight}>
          {rightComponent}
        </View>
      </View>
      <View style={[styles.content, contentStyle]}>
        {children}
      </View>
    </View>
  );
}

/**
 * Component styles
 */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
    paddingHorizontal: 8,
    height: 48,
  },
  headerLeft: {
    flex: 1,
    alignItems: 'flex-start',
  },
  headerCenter: {
    flex: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerRight: {
    flex: 1,
    alignItems: 'flex-end',
  },
  closeButton: {
    padding: 8,
    borderRadius: 20,
    backgroundColor: colors.primaryLight_1,
  },
  logo: {
    opacity: 0.9,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.COLOR_BLACK,
  },
  content: {
    flex: 1,
    width: '100%',
  },
});