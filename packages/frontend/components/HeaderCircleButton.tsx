import React from 'react';
import { Platform, StyleSheet, TouchableOpacity, View, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme } from '@oxyhq/bloom/theme';
import { cn } from '@/lib/utils';

const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

// Subtle backdrop blur radius for the web chip — enough to frost the banner
// behind it without smearing, mirroring the reference's `backdrop-blur-[2px]`.
const WEB_BLUR_RADIUS = '4px';

/**
 * Web-only style extension. React Native's `ViewStyle` doesn't declare the CSS
 * backdrop-filter props, but on web (react-native-web) unknown style keys are
 * forwarded to the DOM, so these render as real CSS. Gated behind the web branch
 * so they never reach native. Same approach as `BottomBar`'s frosted surface.
 */
interface WebBackdropStyle extends ViewStyle {
  backdropFilter?: string;
  WebkitBackdropFilter?: string;
}

const WEB_BLUR_STYLE: WebBackdropStyle = {
  backdropFilter: `blur(${WEB_BLUR_RADIUS})`,
  WebkitBackdropFilter: `blur(${WEB_BLUR_RADIUS})`,
};

const isWeb = Platform.OS === 'web';

interface HeaderCircleButtonProps {
  onPress: () => void;
  /** Accessible name for the action (e.g. "Settings", "Analytics"). */
  accessibilityLabel: string;
  /** The centered icon. Caller owns its size + color (frosted vs. active). */
  children: React.ReactNode;
  disabled?: boolean;
  /**
   * Renders a solid `primary` chip instead of the frosted translucent surface —
   * the "on" state of a toggle icon button (e.g. an active poke). When set the
   * caller should also render the icon in `primaryForeground`.
   */
  active?: boolean;
}

/**
 * Compact (36px) circular icon button with a frosted-glass surface: a
 * translucent `card`/surface token that lightens on hover/press, a soft short
 * shadow, and a subtle backdrop blur so the banner behind shows through.
 *
 * Blur is platform-split: on web a real CSS `backdrop-filter` (NativeWind 5's
 * `react-native-css` has no backdrop-filter support, so this is set inline and
 * web-gated); on native a real `expo-blur` `BlurView` sits behind a themed
 * translucent overlay. Both keep the tint on a Bloom token, so it stays
 * theme-aware (light + dark) and reads over the banner AND solid areas.
 */
export function HeaderCircleButton({
  onPress,
  accessibilityLabel,
  children,
  disabled = false,
  active = false,
}: HeaderCircleButtonProps) {
  const theme = useTheme();

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected: active }}
      className={cn(
        'h-9 w-9 items-center justify-center rounded-full shadow-sm dark:shadow-none',
        !isWeb && 'overflow-hidden',
        active
          ? 'bg-primary'
          : isWeb
            ? 'bg-card/65 hover:bg-card/80 active:bg-card/80'
            : undefined,
        disabled && 'opacity-60',
      )}
      style={!active && isWeb ? WEB_BLUR_STYLE : undefined}
    >
      {!active && !isWeb && (
        <>
          <BlurView
            intensity={24}
            tint={theme.isDark ? 'dark' : 'light'}
            experimentalBlurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFill}
          />
          <View pointerEvents="none" className="absolute inset-0 bg-card/60" />
        </>
      )}
      {children}
    </TouchableOpacity>
  );
}
