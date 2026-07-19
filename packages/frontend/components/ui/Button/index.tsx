/**
 * Unified Button Component System
 * Consolidates all button implementations across the app for consistency and maintainability
 *
 * Supports:
 * - Primary/Secondary variants
 * - Icon buttons
 * - Link buttons (with href)
 * - Accessibility
 */

import React, { useMemo, useCallback, memo } from 'react';
import {
  TouchableOpacity,
  Text,
  TextStyle,
  Platform,
  ViewStyle,
  Pressable,
} from 'react-native';
import { Link, useRouter, type Href } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@oxyhq/bloom/theme';
import { useHaptics } from '@oxyhq/bloom/hooks';
import { flattenStyleArray } from '@/styles/shared';

import type { ButtonProps } from './types';
export type { ButtonProps, ButtonVariant, ButtonSize } from './types';

const SIZE_CONFIG = {
  small: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    fontSize: 14,
    iconSize: 18,
    minHeight: 32,
  },
  medium: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    fontSize: 15,
    iconSize: 20,
    minHeight: 40,
  },
  large: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    fontSize: 16,
    iconSize: 24,
    minHeight: 48,
  },
} as const;

/**
 * Unified Button Component
 * Handles all button variants and use cases
 */
const ButtonComponent: React.FC<ButtonProps> = ({
  onPress,
  children,
  disabled = false,
  variant = 'primary',
  size = 'medium',
  style,
  textStyle,
  contentStyle,
  className,
  href,
  as = 'button',
  icon,
  iconPosition = 'left',
  iconSize: customIconSize,
  customIcon,
  accessibilityLabel,
  accessibilityHint,
  hitSlop,
  activeOpacity,
}) => {
  const theme = useTheme();
  const haptic = useHaptics();
  const router = useRouter();

  const effectiveVariant = variant;

  // Size configuration
  const sizeConfig = SIZE_CONFIG[size];
  const effectiveIconSize = customIconSize ?? sizeConfig.iconSize;

  // Handle link navigation
  const handlePress = useCallback(() => {
    if (disabled) return;
    haptic('light');
    if (href && as === 'link') {
      router.push(href);
      return;
    }
    onPress?.();
  }, [disabled, haptic, href, as, router, onPress]);

  // Base button styles
  const baseStyles = useMemo(() => {
    const styles: ViewStyle = {
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      overflow: 'hidden' as const,
    };

    // Size-based styles
    if (effectiveVariant !== 'icon') {
      styles.paddingVertical = sizeConfig.paddingVertical;
      styles.paddingHorizontal = sizeConfig.paddingHorizontal;
      styles.minHeight = sizeConfig.minHeight;
    }

    // Variant-specific styles
    switch (effectiveVariant) {
      case 'primary':
        styles.backgroundColor = theme.colors.primary;
        styles.borderRadius = 20;
        break;
      case 'secondary':
        styles.backgroundColor = 'transparent';
        styles.borderWidth = 1;
        styles.borderColor = theme.colors.border;
        styles.borderRadius = 20;
        break;
      case 'icon':
        // bg/border set via NativeWind className for CSS variable inheritance
        styles.borderRadius = 100;
        styles.padding = 8;
        styles.width = sizeConfig.minHeight;
        styles.height = sizeConfig.minHeight;
        break;
      case 'ghost':
        styles.backgroundColor = 'transparent';
        styles.borderRadius = 8;
        break;
      case 'text':
      case 'link':
        styles.backgroundColor = 'transparent';
        styles.paddingVertical = 4;
        styles.paddingHorizontal = 8;
        break;
    }

    return styles;
  }, [effectiveVariant, sizeConfig, theme]);

  // Text styles
  const textStyles = useMemo(() => {
    const styles: TextStyle = {
      fontSize: sizeConfig.fontSize,
      fontWeight: Platform.OS === 'web' ? 'bold' : '600',
    };

    switch (effectiveVariant) {
      case 'primary':
        styles.color = theme.colors.card;
        break;
      case 'secondary':
        styles.color = theme.colors.text;
        break;
      case 'icon':
        // No text in icon buttons
        break;
      case 'ghost':
      case 'text':
      case 'link':
        styles.color = theme.colors.primary;
        break;
    }

    return styles;
  }, [effectiveVariant, sizeConfig, theme]);

  // Disabled styles
  const disabledStyles = disabled ? { opacity: 0.5 } : {};

  // Combined styles for the inner button.
  const combinedStyles = useMemo(
    () => flattenStyleArray([
      baseStyles,
      style,
      disabledStyles,
      contentStyle,
    ]),
    [baseStyles, style, disabledStyles, contentStyle]
  );

  // Icon component
  const iconElement = useMemo(() => {
    if (customIcon) return customIcon;
    if (icon) {
      return (
        <Ionicons
          name={icon}
          size={effectiveIconSize}
          color={
            effectiveVariant === 'primary'
              ? theme.colors.card
              : theme.colors.text
          }
        />
      );
    }
    return null;
  }, [customIcon, icon, effectiveIconSize, effectiveVariant, theme]);

  // Content component
  const contentElement = useMemo(() => {
    if (children) {
      return <Text style={flattenStyleArray([textStyles, textStyle])}>{children}</Text>;
    }
    return null;
  }, [children, textStyles, textStyle]);

  // Default hit slop for icon buttons
  const defaultHitSlop = effectiveVariant === 'icon'
    ? { top: 10, bottom: 10, left: 10, right: 10 }
    : undefined;

  // Button content
  const buttonContent = (
    <>
      {iconPosition === 'left' && iconElement}
      {contentElement}
      {iconPosition === 'right' && iconElement}
    </>
  );

  // Handle link vs button rendering
  if (href && as === 'link') {
    return (
      <Link href={href} asChild>
        <Pressable style={combinedStyles}>{buttonContent}</Pressable>
      </Link>
    );
  }

  // Regular button
  const iconBaseClass = effectiveVariant === 'icon' ? 'bg-background border border-border' : undefined;
  const mergedClassName = [iconBaseClass, className].filter(Boolean).join(' ') || undefined;
  return (
    <TouchableOpacity
      className={mergedClassName}
      style={combinedStyles}
      onPress={handlePress}
      disabled={disabled}
      activeOpacity={activeOpacity ?? (effectiveVariant === 'icon' ? 0.7 : 0.8)}
      hitSlop={hitSlop || defaultHitSlop}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
    >
      {buttonContent}
    </TouchableOpacity>
  );
};

export const Button = memo(ButtonComponent);

Button.displayName = 'Button';

// Export convenience variants
export const PrimaryButton = memo((props: Omit<ButtonProps, 'variant'>) => (
  <Button {...props} variant="primary" />
));

export const SecondaryButton = memo((props: Omit<ButtonProps, 'variant'>) => (
  <Button {...props} variant="secondary" />
));

export const IconButton = memo((props: Omit<ButtonProps, 'variant'> & { variant?: 'icon' }) => (
  <Button {...props} variant="icon" />
));

type LinkButtonProps = Omit<ButtonProps, 'variant' | 'as' | 'href'> & {
  href: Href;
};
export const LinkButton = memo((props: LinkButtonProps) => (
  <Button {...props} variant="link" as="link" />
));

PrimaryButton.displayName = 'PrimaryButton';
SecondaryButton.displayName = 'SecondaryButton';
IconButton.displayName = 'IconButton';
LinkButton.displayName = 'LinkButton';

export default Button;
