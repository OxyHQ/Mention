/**
 * Button component types
 */

import { ViewStyle, TextStyle, StyleProp } from 'react-native';
import type { Href } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'icon'
  | 'link'
  | 'ghost'
  | 'text';

export type ButtonSize = 'small' | 'medium' | 'large';

export interface ButtonProps {
  // Core props
  onPress?: () => void;
  children?: React.ReactNode;
  disabled?: boolean;

  // Variant and styling
  variant?: ButtonVariant;
  size?: ButtonSize;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  className?: string;
  
  // Link support (replaces onPress when provided)
  href?: Href;
  as?: 'link' | 'button';
  
  // Icon support
  icon?: keyof typeof Ionicons.glyphMap;
  iconPosition?: 'left' | 'right';
  iconSize?: number;
  customIcon?: React.ReactNode;

  // Responsive support (SideBar button pattern)
  renderText?: ({ state }: { state: 'desktop' | 'tablet' }) => React.ReactNode;
  renderIcon?: ({ state }: { state: 'desktop' | 'tablet' }) => React.ReactNode;
  containerStyle?: ({ state }: { state: 'desktop' | 'tablet' }) => ViewStyle;
  
  // Accessibility
  accessibilityLabel?: string;
  accessibilityHint?: string;
  hitSlop?: { top: number; bottom: number; left: number; right: number };
  
  // Active opacity
  activeOpacity?: number;
}

