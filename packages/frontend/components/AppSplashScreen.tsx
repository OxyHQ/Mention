import React, { useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Animated, StyleSheet, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { LogoIcon } from '@/assets/logo';
import { Loading } from '@oxyhq/bloom/loading';

interface AppSplashScreenProps {
    onFadeComplete?: () => void;
    startFade?: boolean;
}

const FADE_DURATION = 500;
const LOGO_SIZE = 100;
const SPINNER_SIZE = 28;
// The splash renders during font loading via BloomThemeProvider's `onFontsLoading`,
// i.e. BEFORE the theme context is available — so it must NOT depend on `useTheme()`
// (which throws outside the provider). It intentionally shows a consistent dark
// brand gradient so the white logo/spinner stay visible regardless of theme/mode.
const SPLASH_GRADIENT = ['#1A1A1A', '#005c67'] as const;

const AppSplashScreen: React.FC<AppSplashScreenProps> = ({
    onFadeComplete,
    startFade = false
}) => {
    const fadeAnim = useRef(new Animated.Value(1)).current;
    const animationRef = useRef<Animated.CompositeAnimation | null>(null);

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
                colors={SPLASH_GRADIENT}
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
