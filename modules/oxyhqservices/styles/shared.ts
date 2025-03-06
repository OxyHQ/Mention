/**
 * Shared Styles
 * 
 * This file contains shared styles used across the OxyHQ services module.
 * These styles establish a consistent design language for the application.
 */

import { StyleSheet } from 'react-native';
import { colors } from './colors';

/**
 * Theme variables for consistent sizing, spacing, and visual elements
 */
export const theme = {
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32
  },
  radius: {
    sm: 8,
    md: 16,
    lg: 28
  },
  fontSize: {
    small: 14,
    regular: 16,
    large: 18,
    xlarge: 24,
    xxlarge: 32
  },
  animation: {
    fast: '200ms',
    normal: '300ms',
    slow: '500ms'
  }
};

/**
 * Shared styles used throughout the application
 */
export const sharedStyles = StyleSheet.create({
  // ======== Form Elements ========
  input: {
    width: '100%',
    height: 56,
    paddingHorizontal: 20,
    borderWidth: 1.5,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: theme.radius.lg,
    color: colors.COLOR_BLACK,
    backgroundColor: colors.primaryLight_1,
    fontSize: theme.fontSize.regular,
    boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.05)',
    elevation: 2,
  },
  inputWrapper: {
    width: '100%',
    maxWidth: 400,
    marginBottom: theme.spacing.md,
  },
  
  // ======== Buttons ========
  button: {
    height: 56,
    borderRadius: theme.radius.lg,
    overflow: 'hidden',
    boxShadow: '0px 4px 8px rgba(0, 0, 0, 0.2)',
    elevation: 4,
  },
  buttonGradient: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: {
    color: colors.primaryLight,
    fontWeight: '600',
    fontSize: theme.fontSize.regular + 1,
  },
  buttonOutline: {
    height: 56,
    paddingHorizontal: theme.spacing.lg,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: theme.radius.lg,
    borderWidth: 1.5,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    backgroundColor: colors.primaryLight_1,
  },
  buttonOutlineText: {
    color: colors.COLOR_BLACK,
    fontWeight: '600',
    fontSize: theme.fontSize.regular + 1,
  },

  // ======== Typography ========
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    marginBottom: theme.spacing.md,
    textAlign: 'center',
    color: colors.COLOR_BLACK,
  },
  subtitle: {
    fontSize: theme.fontSize.regular + 1,
    textAlign: 'center',
    marginBottom: theme.spacing.xl * 1.5,
    color: colors.COLOR_BLACK_LIGHT_4,
    lineHeight: 24,
  },

  // ======== Lists ========
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: theme.spacing.md - 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  listItemText: {
    fontSize: theme.fontSize.regular,
    fontWeight: '600',
    color: colors.COLOR_BLACK,
  },
  listItemSubtext: {
    fontSize: theme.fontSize.small,
    color: colors.COLOR_BLACK_LIGHT_4,
  },

  // ======== Layout ========
  container: {
    flex: 1,
    width: '100%',
    paddingHorizontal: theme.spacing.md,
    gap: theme.spacing.md,
  },
  content: {
    width: '100%',
    alignItems: 'center',
    paddingVertical: 20,
    maxWidth: 400,
    alignSelf: 'center',
  },

  // ======== Progress Indicators ========
  progressContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: theme.spacing.xl,
    paddingHorizontal: 20,
  },
  progressDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
    borderWidth: 2,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
  },
  progressDotActive: {
    backgroundColor: colors.primaryColor,
    borderColor: colors.primaryColor,
    transform: [{ scale: 1.2 }],
  },
  progressDotCompleted: {
    backgroundColor: colors.primaryColor,
    borderColor: colors.primaryColor,
  },
  progressLine: {
    flex: 1,
    height: 2,
    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
    marginHorizontal: theme.spacing.xs,
  },
  progressLineCompleted: {
    backgroundColor: colors.primaryColor,
  },
});