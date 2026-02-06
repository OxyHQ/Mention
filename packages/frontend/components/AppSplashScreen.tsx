import React, { useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Animated, StyleSheet, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { cssInterop } from 'nativewind';
import { LogoIcon } from '@/assets/logo';
import { LoadingSpinner } from '@/components/ui/Loading';
import { useTheme } from '@/hooks/useTheme';

// Configure LinearGradient for NativeWind
cssInterop(LinearGradient, {
    className: {
        target: 'style',
    },
});

interface AppSplashScreenProps {
    onFadeComplete?: () => void;
    startFade?: boolean;
}

const FADE_DURATION = 500;
const LOGO_SIZE = 100;
const SPINNER_SIZE = 28;

const AppSplashScreen: React.FC<AppSplashScreenProps> = ({
    onFadeComplete,
    startFade = false
}) => {
    const theme = useTheme();
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

    // Gradient colors: Use consistent dark gradient that works before theme loads
    // This prevents the logo/spinner from being invisible on white background
    const gradientColors = useMemo(
        () => [
            theme?.colors?.background || '#1A1A1A',
            theme?.colors?.primary || '#005c67',
        ] as const,
        [theme?.colors?.background, theme?.colors?.primary]
    );

    return (
        <Animated.View style={containerStyle}>
            <LinearGradient
                colors={gradientColors}
                style={styles.gradient}
            >
                <View style={styles.logoContainer}>
                    <LogoIcon size={LOGO_SIZE} color="white" />
                    <View style={styles.spinnerContainer}>
                        <LoadingSpinner iconSize={SPINNER_SIZE} color="white" showText={false} />
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
