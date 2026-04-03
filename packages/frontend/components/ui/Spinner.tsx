/**
 * Themed spinner component.
 *
 * Uses the app's own SVG loading icon which supports NativeWind className
 * for scoped CSS variable inheritance (e.g. profile color theming).
 *
 * Usage:
 *   <Spinner />                          // default: size 28, text-primary
 *   <Spinner size={16} />                // small (for buttons)
 *   <Spinner className="text-foreground" /> // custom color
 */
import React, { memo } from 'react';
import { View, type ViewStyle } from 'react-native';
import { Loading } from '@/assets/icons/loading-icon';

interface SpinnerProps {
  size?: number;
  className?: string;
  style?: ViewStyle;
}

export const Spinner = memo<SpinnerProps>(({ size = 28, className = 'text-primary', style }) => (
  <View style={[{ alignItems: 'center', justifyContent: 'center' }, style]}>
    <Loading size={size} className={className} />
  </View>
));

Spinner.displayName = 'Spinner';
