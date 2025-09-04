import React, { useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Animated } from 'react-native';
import { LogoIcon } from '@/assets/logo';
import LoadingSpinner from './LoadingSpinner';
import { colors } from '@/styles/colors';
import { LinearGradient } from 'expo-linear-gradient';
import { cssInterop } from 'nativewind';

interface AppSplashScreenProps {
    onFadeComplete?: () => void;
    startFade?: boolean;
}

const AppSplashScreen: React.FC<AppSplashScreenProps> = ({ onFadeComplete, startFade = false }) => {
    cssInterop(LinearGradient, {
        className: {
            target: 'style',
        },
    });
    const fadeAnim = useRef(new Animated.Value(1)).current; // Use useRef to prevent recreation
    const animationRef = useRef<Animated.CompositeAnimation | null>(null);

    // Memoize the fade completion callback to prevent recreating it
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
            if (animationRef.current) {
                animationRef.current.stop();
            }

            // Start fade out immediately when startFade becomes true, taking 500ms to complete
            animationRef.current = Animated.timing(fadeAnim, {
                toValue: 0,
                duration: 500,
                useNativeDriver: true,
            });

            animationRef.current.start(({ finished }) => {
                handleFadeComplete(finished);
            });
        }

        // Cleanup function to stop animation if component unmounts
        return () => {
            if (animationRef.current) {
                animationRef.current.stop();
            }
        };
    }, [startFade, fadeAnim, handleFadeComplete]);

    // Memoize styles to prevent recreation on every render
    const containerStyle = useMemo(() => ({ flex: 1, opacity: fadeAnim }), [fadeAnim]);
    const logoContainerStyle = useMemo(
        () => ({ alignItems: 'center' as const, justifyContent: 'center' as const }),
        [],
    );
    const spinnerContainerStyle = useMemo(() => ({ marginTop: 32 }), []);

    // Memoize gradient colors to prevent array recreation
    const gradientColors = useMemo(() => [colors.primaryColor, colors.secondaryLight] as const, []);

    return (
        <Animated.View style={containerStyle}>
            <LinearGradient
                colors={gradientColors}
                className="flex-1 items-center justify-center bg-primary-light dark:bg-primary-dark"
            >
                <View style={logoContainerStyle}>
                    <LogoIcon size={100} color={colors.secondaryColor} />
                    <View style={spinnerContainerStyle}>
                        <LoadingSpinner size={28} color={colors.secondaryColor} showText={false} />
                    </View>
                </View>
            </LinearGradient>
        </Animated.View>
    );
};

export default React.memo(AppSplashScreen);
