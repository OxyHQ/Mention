import { Platform } from 'react-native';
import { Color } from 'expo-router';
import type { ThemeColors } from '@/hooks/useTheme';

// Color API returns PlatformColor (ColorValue) objects which work at runtime
// in all RN style props but TypeScript types them as OpaqueColorValue.
// We cast to string since ThemeColors uses string for broad compatibility.
const c = (v: any): string => v;

function getAndroidColors(): ThemeColors {
  const d = Color.android.dynamic;
  return {
    background: c(d.surface),
    backgroundSecondary: c(d.surfaceContainerLow),
    backgroundTertiary: c(d.surfaceContainer),

    text: c(d.onSurface),
    textSecondary: c(d.onSurfaceVariant),
    textTertiary: c(d.outline),

    border: c(d.outlineVariant),
    borderLight: c(d.outline),

    primary: c(d.primary),
    primaryLight: c(d.primaryContainer),
    primaryDark: c(d.onPrimaryContainer),

    secondary: c(d.secondary),

    tint: c(d.primary),
    icon: c(d.onSurfaceVariant),
    iconActive: c(d.primary),

    success: '#10B981',
    error: '#EF4444',
    warning: '#F59E0B',
    info: '#3B82F6',

    primarySubtle: c(d.primaryContainer),
    primarySubtleForeground: c(d.onPrimaryContainer),
    negative: '#B91C1C',
    negativeForeground: '#FFFFFF',
    negativeSubtle: c(d.errorContainer),
    negativeSubtleForeground: c(d.onErrorContainer),
    contrast50: c(d.surfaceContainerLow),

    card: c(d.surfaceContainerLow),
    shadow: 'rgba(0, 0, 0, 0.2)',
    overlay: 'rgba(0, 0, 0, 0.5)',
  };
}

function getIOSColors(): ThemeColors {
  const i = Color.ios;
  return {
    background: c(i.systemBackground),
    backgroundSecondary: c(i.secondarySystemBackground),
    backgroundTertiary: c(i.tertiarySystemBackground),

    text: c(i.label),
    textSecondary: c(i.secondaryLabel),
    textTertiary: c(i.tertiaryLabel),

    border: c(i.separator),
    borderLight: c(i.opaqueSeparator),

    primary: c(i.systemBlue),
    primaryLight: c(i.systemGray6),
    primaryDark: c(i.systemBlue),

    secondary: c(i.systemPurple),

    tint: c(i.systemBlue),
    icon: c(i.secondaryLabel),
    iconActive: c(i.systemBlue),

    success: c(i.systemGreen),
    error: c(i.systemRed),
    warning: c(i.systemOrange),
    info: c(i.systemBlue),

    primarySubtle: c(i.systemGray6),
    primarySubtleForeground: c(i.systemBlue),
    negative: c(i.systemRed),
    negativeForeground: '#FFFFFF',
    negativeSubtle: c(i.systemGray6),
    negativeSubtleForeground: c(i.systemRed),
    contrast50: c(i.systemGray6),

    card: c(i.secondarySystemBackground),
    shadow: 'rgba(0, 0, 0, 0.15)',
    overlay: 'rgba(0, 0, 0, 0.5)',
  };
}

export function getAdaptiveColors(): ThemeColors | null {
  if (Platform.OS === 'android') return getAndroidColors();
  if (Platform.OS === 'ios') return getIOSColors();
  return null;
}
