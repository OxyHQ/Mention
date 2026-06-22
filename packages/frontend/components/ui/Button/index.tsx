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
import { Link, useRouter, type Href } from 'expo-router';
import Animated, { useAnimatedStyle, SharedValue } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMediaQuery } from 'react-responsive';

import { useTheme } from '@oxyhq/bloom/theme';
import { useHaptics } from '@/hooks/useHaptics';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import { useKeyboardVisibility } from '@/hooks/useKeyboardVisibility';
import { Z_INDEX } from '@/lib/constants';
import { flattenStyleArray } from '@/styles/shared';

import type { ButtonProps, ButtonVariant } from './types';
export type { ButtonProps, ButtonVariant, ButtonSize } from './types';

const IS_WEB = Platform.OS === 'web';

// WEB floating-FAB positioning lives in NativeWind classes (`web:fixed` pins the
// FAB to the viewport; `web:right-6` = 24px; `web:z-[10000]` =
// Z_INDEX.FLOATING_ACTION_BUTTON). The `bottom` inset is dynamic (bottom-bar +
// safe-area aware) so it stays as a valid inline `ViewStyle` number. RN's
// `ViewStyle` doesn't model `position: 'fixed'`, so web NEVER sets `position`
// inline — the class owns it — and only native sets the inline `'absolute'`
// (which IS a valid `ViewStyle` value). Net: zero casts.
const FLOATING_WEB_CLASS = 'web:fixed web:right-6 web:z-[10000]';

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
  const haptic = useHaptics();
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
    haptic('Light');
    if (href && as === 'link') {
      router.push(href);
      return;
    }
    onPress?.();
  }, [disabled, haptic, href, as, router, onPress]);
  
  // Floating button positioning. WEB pins to the VIEWPORT via the `web:fixed`
  // NativeWind class (never an inline `position`) so the FAB never scrolls away
  // under the document-scroll layout; the dynamic `bottom` inset stays inline.
  // NATIVE sets the inline `position: 'absolute'` ('absolute' is a valid
  // ViewStyle value — no cast) so the screen's ScrollView scrolls under the
  // overlay. On web `right`/`zIndex` come from `FLOATING_WEB_CLASS`, so the
  // inline values here only matter on native.
  const floatingStyles = useMemo<ViewStyle>(() => {
    if (!floating) return {};

    const flatStyle: ViewStyle = StyleSheet.flatten(style) ?? {};
    if ('position' in flatStyle) {
      return {
        ...(IS_WEB ? {} : { position: flatStyle.position ?? 'absolute' }),
        bottom: flatStyle.bottom ?? bottomOffset,
        right: flatStyle.right ?? 24,
        left: flatStyle.left,
        top: flatStyle.top,
        zIndex: flatStyle.zIndex ?? Z_INDEX.FLOATING_ACTION_BUTTON,
      };
    }

    const bottomBarVisible = !isScreenNotMobile && !keyboardVisible;
    const bottomBarHeight = bottomBarVisible ? 60 : 0;
    const marginFromBottom = 16;
    const defaultBottom = bottomOffset ?? (bottomBarHeight + insets.bottom + marginFromBottom);

    return {
      ...(IS_WEB ? {} : { position: 'absolute' }),
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
        // bg/border set via NativeWind className for CSS variable inheritance
        styles.borderRadius = 100;
        styles.padding = 8;
        styles.width = sizeConfig.minHeight;
        styles.height = sizeConfig.minHeight;
        break;
      case 'floating':
        styles.width = 48;
        styles.height = 48;
        styles.borderRadius = 24;
        styles.backgroundColor = theme.colors.primary;
        styles.boxShadow = '0px 2px 6px 0px rgba(0, 0, 0, 0.12)';
        styles.elevation = 3;
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
  
  // A floating FAB that also animates (auto-hide drop) must keep its
  // `position: fixed` (web) on the SAME element that carries the reanimated
  // transform — the Animated.View wrapper. CSS makes any transformed ancestor the
  // containing block for `fixed`/`absolute` descendants, so a `fixed` inner button
  // inside a transformed wrapper would re-anchor to the (in-flow, scrolling)
  // wrapper instead of the viewport. So when floating + animated, the floating
  // position is HOISTED to the wrapper and excluded from the inner button.
  const isAnimated = Boolean(animatedTranslateY || animatedOpacity);
  const hoistFloatingToWrapper = floating && isAnimated;

  // Combined styles for the inner button. The floating position is included here
  // ONLY when it is NOT hoisted to the animated wrapper (the static-FAB case).
  const combinedStyles = useMemo(
    () => flattenStyleArray([
      baseStyles,
      floating && !hoistFloatingToWrapper && floatingStyles,
      style,
      disabledStyles,
      contentStyle,
    ]),
    [baseStyles, floating, hoistFloatingToWrapper, floatingStyles, style, disabledStyles, contentStyle]
  );

  // The `web:fixed`/right/z floating position lives in a NativeWind class so web
  // never needs an inline `position: 'fixed'` cast. It goes on whichever element
  // owns the floating layout: the animated wrapper when hoisted (so `fixed`
  // anchors to the viewport, not the transformed wrapper), else the inner button.
  const floatingWebClassForButton = floating && !hoistFloatingToWrapper ? FLOATING_WEB_CLASS : undefined;
  
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
      <Link href={href} asChild>
        <Pressable style={finalStyle}>{buttonContent}</Pressable>
      </Link>
    );
  }

  // Responsive button (SideBar pattern)
  if (isResponsive) {
    if (href) {
      return (
        <Link href={href} asChild>
          <Pressable style={responsiveContainerStyle || finalStyle}>
            {buttonContent}
          </Pressable>
        </Link>
      );
    }
    return (
      <Pressable
        style={responsiveContainerStyle || finalStyle}
        onPress={handlePress}
      >
        {buttonContent}
      </Pressable>
    );
  }
  
  // Regular button
  const iconBaseClass = effectiveVariant === 'icon' ? 'bg-background border border-border' : undefined;
  const mergedClassName = [iconBaseClass, floatingWebClassForButton, className].filter(Boolean).join(' ') || undefined;
  const TouchableComponent = (
    <TouchableOpacity
      className={mergedClassName}
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
  
  // Wrap in Animated.View if animations are provided. When this is a floating
  // FAB, the floating position (web: `position: fixed`) lives HERE on the
  // animated wrapper — the same element as the transform — so `fixed` anchors to
  // the viewport and the auto-hide translate still works (see
  // `hoistFloatingToWrapper`).
  if (animatedTranslateY || animatedOpacity) {
    return (
      <Animated.View
        className={hoistFloatingToWrapper ? FLOATING_WEB_CLASS : undefined}
        style={hoistFloatingToWrapper ? [floatingStyles, animatedStyle] : animatedStyle}
      >
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

type LinkButtonProps = Omit<ButtonProps, 'variant' | 'as' | 'href'> & {
  href: Href;
};
export const LinkButton = memo((props: LinkButtonProps) => (
  <Button {...props} variant="link" as="link" />
));

PrimaryButton.displayName = 'PrimaryButton';
SecondaryButton.displayName = 'SecondaryButton';
IconButton.displayName = 'IconButton';
FloatingActionButton.displayName = 'FloatingActionButton';
LinkButton.displayName = 'LinkButton';

export default Button;

