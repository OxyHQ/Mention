import React, { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { View, Animated, StyleSheet, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { APP_COLOR_NAMES, type AppColorName, type PersistedThemeState } from '@oxyhq/bloom/theme';
import { getPresetVars } from '@oxyhq/bloom/preset-vars';
import { LogoIcon } from '@/assets/logo';
import { Loading } from '@oxyhq/bloom/loading';
import { BLOOM_THEME_PERSIST_KEY, BLOOM_THEME_STORAGE } from '@/lib/themePersistence';

interface AppSplashScreenProps {
    onFadeComplete?: () => void;
    startFade?: boolean;
}

const FADE_DURATION = 500;
const LOGO_SIZE = 100;
const SPINNER_SIZE = 28;

// The splash renders during font loading via BloomThemeProvider's `onFontsLoading`,
// i.e. BEFORE the theme context is available — so it must NOT depend on `useTheme()`
// (which throws outside the provider). Instead it reads the SAME persisted theme key
// that the provider writes (`BLOOM_THEME_PERSIST_KEY`) and derives a DARK gradient
// from the active preset's DARK-mode `--background` (a very dark, preset-tinted
// surface from the colour engine). The logo + spinner are white, so we use the
// dark-mode background — never the preset's near-white light `--background`.

// Safe literal fallback when no preset can be resolved at all (missing key,
// unparseable JSON, unknown preset, storage unavailable). Both stops are dark.
const FALLBACK_GRADIENT: readonly [string, string] = ['#1A1A1A', '#005c67'];

// `defaultColorPreset` passed to BloomThemeProvider in app/_layout.tsx. Used when
// nothing is persisted yet so the splash matches the provider's eventual default.
const DEFAULT_PRESET: AppColorName = 'blue';

// Near-black second stop, shared across presets so the gradient always bottoms out dark.
const DARK_STOP = '#1A1A1A';

/**
 * Build a DARK two-stop gradient from a preset. Stop 1 is the engine's dark-mode
 * `--background` for the preset (a very dark, preset-tinted surface), stop 2 is
 * near-black, so the white logo/spinner always stay clearly visible regardless of
 * preset. Falls back to the safe literal when the preset can't be resolved.
 */
function buildDarkGradient(presetName: AppColorName): readonly [string, string] {
    const darkBackground = getPresetVars(presetName, 'dark')['--background'];
    if (!darkBackground) return FALLBACK_GRADIENT;
    return [darkBackground, DARK_STOP];
}

/** Validate an unknown value as a known preset name. */
function isAppColorName(value: unknown): value is AppColorName {
    return (
        typeof value === 'string'
        && APP_COLOR_NAMES.some((name) => name === value)
    );
}

/**
 * Parse a persisted theme JSON string and return its preset name, or `null` if
 * absent/unparseable/unknown. Best-effort: a malformed stored value must never
 * crash the splash.
 */
function readPresetFromRaw(raw: string | null): AppColorName | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as PersistedThemeState;
        return isAppColorName(parsed.colorPreset) ? parsed.colorPreset : null;
    } catch {
        // best-effort: a corrupt persisted value falls through to the default preset.
        return null;
    }
}

/**
 * Synchronous web read of the persisted preset. Avoids a flash by resolving the
 * gradient before the first paint. Returns `null` on native or when nothing usable
 * is stored (callers fall back to the default preset).
 */
function readWebPresetSync(): AppColorName | null {
    if (Platform.OS !== 'web') return null;
    const getItem = BLOOM_THEME_STORAGE.getItem(BLOOM_THEME_PERSIST_KEY);
    // On web the adapter (`webLocalStorage`) is synchronous, so `getItem` is a string.
    return typeof getItem === 'string' || getItem === null ? readPresetFromRaw(getItem) : null;
}

const AppSplashScreen: React.FC<AppSplashScreenProps> = ({
    onFadeComplete,
    startFade = false
}) => {
    const fadeAnim = useRef(new Animated.Value(1)).current;
    const animationRef = useRef<Animated.CompositeAnimation | null>(null);

    // Web resolves synchronously (no flash); native starts at the default preset and
    // updates after a single mount-time async read below.
    const [preset, setPreset] = useState<AppColorName>(
        () => readWebPresetSync() ?? DEFAULT_PRESET,
    );

    // Native-only: one mount-time async read of the persisted preset. Web already
    // resolved synchronously in the initial state, so this is gated to native.
    useEffect(() => {
        if (Platform.OS === 'web') return;
        let cancelled = false;
        Promise.resolve(BLOOM_THEME_STORAGE.getItem(BLOOM_THEME_PERSIST_KEY))
            .then((raw) => {
                if (cancelled) return;
                const stored = readPresetFromRaw(raw);
                if (stored) setPreset(stored);
            })
            .catch((error: unknown) => {
                // best-effort: keep the default preset if persisted state can't be read.
                if (__DEV__) console.warn('AppSplashScreen: failed to read persisted theme', error);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const gradient = useMemo(() => buildDarkGradient(preset), [preset]);

    const handleFadeComplete = useCallback(
        (finished: boolean) => {
            if (finished && onFadeComplete) {
                onFadeComplete();
            }
        },
        [onFadeComplete],
    );

    useEffect(() => {
        if (startFade) {
            // Cancel any existing animation
            animationRef.current?.stop();

            // Start fade out animation
            animationRef.current = Animated.timing(fadeAnim, {
                toValue: 0,
                duration: FADE_DURATION,
                useNativeDriver: Platform.OS !== 'web',
            });

            animationRef.current.start(({ finished }) => {
                handleFadeComplete(finished);
            });
        }

        return () => {
            animationRef.current?.stop();
        };
    }, [startFade, fadeAnim, handleFadeComplete]);

    // Memoized styles
    const containerStyle = useMemo(
        () => [styles.container, { opacity: fadeAnim }],
        [fadeAnim]
    );

    return (
        <Animated.View style={containerStyle}>
            <LinearGradient
                colors={gradient}
                style={styles.gradient}
            >
                <View style={styles.logoContainer}>
                    <LogoIcon size={LOGO_SIZE} color="white" />
                    <View style={styles.spinnerContainer}>
                        <Loading iconSize={SPINNER_SIZE} color="white" showText={false} />
                    </View>
                </View>
            </LinearGradient>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    gradient: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    logoContainer: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    spinnerContainer: {
        marginTop: 32,
    },
});

export default React.memo(AppSplashScreen);
