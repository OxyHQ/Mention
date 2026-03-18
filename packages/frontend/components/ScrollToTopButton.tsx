import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { ArrowUp } from '@/assets/icons/arrow-up-icon';
import { useLayoutScroll } from '@/context/LayoutScrollContext';

export function ScrollToTopButton() {
    const theme = useTheme();
    const { scrollY, scrollToTop } = useLayoutScroll();
    const [visible, setVisible] = useState(false);
    const anchorRef = useRef<View>(null);
    const [leftPos, setLeftPos] = useState<number | null>(null);

    useEffect(() => {
        const listenerId = scrollY.addListener(({ value }) => {
            setVisible(value > 200);
        });
        return () => {
            scrollY.removeListener(listenerId);
        };
    }, [scrollY]);

    const measure = useCallback(() => {
        if (Platform.OS !== 'web') return;
        requestAnimationFrame(() => {
            anchorRef.current?.measureInWindow((x) => {
                if (typeof x === 'number' && x > 0) {
                    setLeftPos(x - 52);
                }
            });
        });
    }, []);

    useEffect(() => {
        measure();
        if (Platform.OS === 'web') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
    }, [measure]);

    // Always render the anchor so we can measure position
    // Only render the button when visible and position is known
    return (
        <>
            <View
                ref={anchorRef}
                onLayout={measure}
                style={styles.anchor}
            />
            {visible && leftPos !== null && (
                <Pressable
                    onPress={scrollToTop}
                    accessibilityLabel="Scroll to top"
                    className="active:opacity-80"
                    style={[
                        styles.button,
                        {
                            left: leftPos,
                            backgroundColor: theme.colors.card,
                            borderColor: theme.colors.border,
                        },
                        Platform.select({ web: { cursor: 'pointer' as any } }),
                    ]}
                >
                    <ArrowUp size={18} color={theme.colors.textSecondary} />
                </Pressable>
            )}
        </>
    );
}

const styles = StyleSheet.create({
    anchor: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: 1,
        height: 1,
        opacity: 0,
    },
    button: {
        ...Platform.select({
            web: {
                position: 'fixed' as any,
            },
            default: {
                position: 'absolute',
            },
        }),
        bottom: 30,
        width: 42,
        height: 42,
        borderRadius: 21,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
    },
});
