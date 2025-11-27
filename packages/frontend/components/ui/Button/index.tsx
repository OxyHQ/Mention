/**
 * Unified Button Component System
 * Consolidates all button implementations across the app for consistency and maintainability
 * 
 * Supports:
 * - Primary/Secondary variants
 * - Icon buttons
 * - Floating action buttons
 * - Link buttons (with href)
 * - Responsive variants (desktop/tablet)
 * - Animations
 * - Accessibility
 */

import React, { useMemo, useCallback, memo } from 'react';
import { 
  TouchableOpacity, 
  Text, 
  StyleSheet, 
  ViewStyle, 
  TextStyle, 
  Platform,
  StyleProp,
  Pressable,
} from 'react-native';
import { Link, useRouter } from 'expo-router';
import Animated, { useAnimatedStyle, SharedValue } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pressable as WebPressable } from 'react-native-web-hover';
import { useMediaQuery } from 'react-responsive';

import { useTheme } from '@/hooks/useTheme';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import { useKeyboardVisibility } from '@/hooks/useKeyboardVisibility';
import { Z_INDEX } from '@/lib/constants';
import { flattenStyleArray } from '@/styles/shared';

import type { ButtonProps, ButtonVariant } from './types';
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
  href,
  as = 'button',
  icon,
  iconPosition = 'left',
  iconSize: customIconSize,
  customIcon,
  floating = false,
  bottomOffset,
  animatedTranslateY,
  animatedOpacity,
  renderText,
  renderIcon,
  containerStyle,
  accessibilityLabel,
  accessibilityHint,
  hitSlop,
  activeOpacity,
}) => {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isScreenNotMobile = useIsScreenNotMobile();
  const keyboardVisible = useKeyboardVisibility();
  const isDesktop = useMediaQuery({ minWidth: 1266 });
  
  // Determine if this is a responsive button (SideBar pattern)
  const isResponsive = Boolean(renderText || renderIcon || containerStyle);
  const responsiveState = isDesktop ? 'desktop' : 'tablet';
  
  // Determine effective variant
  const effectiveVariant = floating ? 'floating' : variant;
  
  // Size configuration
  const sizeConfig = SIZE_CONFIG[size];
  const effectiveIconSize = customIconSize ?? sizeConfig.iconSize;
  
  // Handle link navigation
  const handlePress = useCallback(() => {
    if (disabled) return;
    if (href && as === 'link') {
      router.push(href);
      return;
    }
    onPress?.();
  }, [disabled, href, as, router, onPress]);
  
  // Floating button positioning
  const floatingStyles = useMemo(() => {
    if (!floating) return {};
    
    const hasCustomPosition = style && typeof style === 'object' && 'position' in (style as ViewStyle);
    if (hasCustomPosition && style) {
      const flatStyle = flattenStyleArray([style]);
      return {
        position: flatStyle.position || 'absolute',
        bottom: flatStyle.bottom || bottomOffset,
        right: flatStyle.right || 24,
        left: flatStyle.left,
        top: flatStyle.top,
        zIndex: flatStyle.zIndex || Z_INDEX.FLOATING_ACTION_BUTTON,
      };
    }
    
    const bottomBarVisible = !isScreenNotMobile && !keyboardVisible;
    const bottomBarHeight = bottomBarVisible ? 60 : 0;
    const marginFromBottom = 16;
    const defaultBottom = bottomOffset ?? (bottomBarHeight + insets.bottom + marginFromBottom);
    
    return {
      position: 'absolute' as const,
      bottom: defaultBottom,
      right: 24,
      zIndex: Z_INDEX.FLOATING_ACTION_BUTTON,
    };
  }, [floating, style, bottomOffset, isScreenNotMobile, keyboardVisible, insets.bottom]);
  
  // Base button styles
  const baseStyles = useMemo(() => {
    const styles: ViewStyle = {
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      overflow: 'hidden' as const,
    };
    
    // Size-based styles
    if (!floating && effectiveVariant !== 'icon') {
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
        styles.backgroundColor = theme.colors.background;
        styles.borderWidth = 1;
        styles.borderColor = theme.colors.border;
        styles.borderRadius = 100;
        styles.padding = 8;
        styles.width = sizeConfig.minHeight;
        styles.height = sizeConfig.minHeight;
        break;
      case 'floating':
        styles.width = 56;
        styles.height = 56;
        styles.borderRadius = 28;
        styles.backgroundColor = theme.colors.primary;
        styles.boxShadow = '0px 4px 8px 0px rgba(0, 0, 0, 0.3)';
        styles.elevation = 8;
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
  }, [effectiveVariant, floating, sizeConfig, theme]);
  
  // Text styles
  const textStyles = useMemo(() => {
    const styles: TextStyle = {
      fontSize: sizeConfig.fontSize,
      fontWeight: Platform.OS === 'web' ? 'bold' : '600',
    };
    
    switch (effectiveVariant) {
      case 'primary':
      case 'floating':
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
  
  // Combined styles
  const combinedStyles = useMemo(
    () => flattenStyleArray([
      baseStyles,
      floating && floatingStyles,
      style,
      disabledStyles,
      contentStyle,
    ]),
    [baseStyles, floating, floatingStyles, style, disabledStyles, contentStyle]
  );
  
  // Animation styles
  // useAnimatedStyle must be called at top level, not inside useMemo
  const animatedStyle = useAnimatedStyle(() => {
    if (!animatedTranslateY && !animatedOpacity) return {};
    
    return {
      transform: animatedTranslateY 
        ? [{ translateY: animatedTranslateY.value }] 
        : undefined,
      opacity: animatedOpacity ? animatedOpacity.value : undefined,
    };
  }, [animatedTranslateY, animatedOpacity]);
  
  // Icon component
  const iconElement = useMemo(() => {
    if (customIcon) return customIcon;
    if (icon) {
      return (
        <Ionicons 
          name={icon} 
          size={effectiveIconSize} 
          color={
            effectiveVariant === 'primary' || effectiveVariant === 'floating'
              ? theme.colors.card
              : theme.colors.text
          } 
        />
      );
    }
    if (renderIcon) {
      return renderIcon({ state: responsiveState });
    }
    return null;
  }, [customIcon, icon, effectiveIconSize, effectiveVariant, theme, renderIcon, responsiveState]);
  
  // Content component
  const contentElement = useMemo(() => {
    if (isResponsive && renderText) {
      return renderText({ state: responsiveState });
    }
    if (children) {
      return <Text style={flattenStyleArray([textStyles, textStyle])}>{children}</Text>;
    }
    return null;
  }, [isResponsive, renderText, responsiveState, children, textStyles, textStyle]);
  
  // Container style for responsive buttons
  const responsiveContainerStyle = useMemo(() => {
    if (isResponsive && containerStyle) {
      return containerStyle({ state: responsiveState });
    }
    return undefined;
  }, [isResponsive, containerStyle, responsiveState]);
  
  // Final combined style
  const finalStyle = isResponsive && responsiveContainerStyle
    ? flattenStyleArray([combinedStyles, responsiveContainerStyle])
    : combinedStyles;
  
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
  
  // If animated, wrap in Animated.View
  const animatedWrapperStyle = animatedOpacity && !floating
    ? { elevation: 0, boxShadow: 'none' as const }
    : undefined;
  
  // Handle link vs button rendering
  if (href && as === 'link' && !isResponsive) {
    return (
      <Link href={href} style={finalStyle}>
        {buttonContent}
      </Link>
    );
  }
  
  // Responsive button (SideBar pattern)
  if (isResponsive) {
    const PressableComponent = Platform.OS === 'web' ? WebPressable : Pressable;
    return (
      <PressableComponent 
        style={responsiveContainerStyle || finalStyle}
        onPress={href ? undefined : handlePress}
      >
        {buttonContent}
      </PressableComponent>
    );
  }
  
  // Regular button
  const TouchableComponent = (
    <TouchableOpacity
      style={flattenStyleArray([finalStyle, animatedWrapperStyle])}
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
  
  // Wrap in Animated.View if animations are provided
  if (animatedTranslateY || animatedOpacity) {
    return (
      <Animated.View style={animatedStyle}>
        {TouchableComponent}
      </Animated.View>
    );
  }
  
  return TouchableComponent;
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

export const FloatingActionButton = memo((props: Omit<ButtonProps, 'variant' | 'floating'>) => (
  <Button {...props} variant="floating" floating={true} />
));

export const LinkButton = memo((props: Omit<ButtonProps, 'variant' | 'as'> & { href: string }) => (
  <Button {...props} variant="link" as="link" />
));

PrimaryButton.displayName = 'PrimaryButton';
SecondaryButton.displayName = 'SecondaryButton';
IconButton.displayName = 'IconButton';
FloatingActionButton.displayName = 'FloatingActionButton';
LinkButton.displayName = 'LinkButton';

export default Button;

