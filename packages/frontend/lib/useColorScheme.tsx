import { useColorScheme as useRNColorScheme } from 'react-native';
import { useThemeStore, type ThemeMode } from './theme-store';
import { setColorSchemeSafe } from './set-color-scheme-safe';
import { useCallback, useEffect, useMemo } from 'react';
import { APP_COLOR_PRESETS } from './app-color-presets';
import { applyDarkClass } from './apply-dark-class';

/** Convert an HSL CSS variable value like "153 50% 5%" to "hsl(153, 50%, 5%)". */
function hslVarToCSS(value: string): string {
  const parts = value.split('/').map((s) => s.trim());
  if (parts.length === 2) {
    const alpha = parseFloat(parts[1]) / 100;
    return `hsla(${parts[0].replace(/ /g, ', ')}, ${alpha})`;
  }
  return `hsl(${value.replace(/ /g, ', ')})`;
}

export function useColorScheme() {
  const rnScheme = useRNColorScheme();
  const { mode, setMode, appColor } = useThemeStore();

  const isAdaptive = mode === 'adaptive';
  const effectiveMode = isAdaptive ? 'system' : mode;
  const resolved: 'light' | 'dark' =
    effectiveMode === 'system' ? (rnScheme ?? 'light') : effectiveMode;

  // Keep the dark class in sync on web for all modes (including system)
  useEffect(() => {
    applyDarkClass(resolved);
  }, [resolved]);

  const setColorScheme = useCallback(
    (newMode: ThemeMode) => {
      setMode(newMode);
      setColorSchemeSafe(newMode);
    },
    [setMode],
  );

  const colors = useMemo(() => {
    const preset = APP_COLOR_PRESETS[appColor];
    const vars = resolved === 'light' ? preset.light : preset.dark;
    return {
      background: hslVarToCSS(vars['--background']),
      foreground: hslVarToCSS(vars['--foreground']),
      sidebar: hslVarToCSS(vars['--sidebar']),
      surface: hslVarToCSS(vars['--surface']),
      surfaceForeground: hslVarToCSS(vars['--surface-foreground']),
      muted: hslVarToCSS(vars['--muted']),
      mutedForeground: hslVarToCSS(vars['--muted-foreground']),
      border: hslVarToCSS(vars['--border']),
      input: hslVarToCSS(vars['--input']),
      primary: preset.hex,
      primaryForeground: hslVarToCSS(vars['--primary-foreground']),
      accent: hslVarToCSS(vars['--accent']),
      accentForeground: hslVarToCSS(vars['--accent-foreground']),
      destructive: hslVarToCSS(vars['--destructive']),
    };
  }, [resolved, appColor]);

  return {
    colorScheme: resolved,
    isDarkColorScheme: resolved === 'dark',
    setColorScheme,
    mode,
    colors,
    isAdaptive,
  };
}
