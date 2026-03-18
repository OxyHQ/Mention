import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { ArrowUp } from '@/assets/icons/arrow-up-icon';
import { useLayoutScroll } from '@/context/LayoutScrollContext';

export function ScrollToTopButton() {
    const theme = useTheme();
    const { scrollY, scrollToTop } = useLayoutScroll();
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const listenerId = scrollY.addListener(({ value }) => {
            setVisible(value > 200);
        });
        return () => {
            scrollY.removeListener(listenerId);
        };
    }, [scrollY]);

    if (!visible) return null;

    return (
        <Pressable
            onPress={scrollToTop}
            accessibilityLabel="Scroll to top"
            style={[
                styles.button,
                {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                },
                Platform.select({ web: { cursor: 'pointer' as any } }),
            ]}
        >
            <ArrowUp size={18} color={theme.colors.textSecondary} />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    button: {
        ...Platform.select({
            web: {
                position: 'fixed' as any,
            },
            default: {
                position: 'absolute',
            },
        }),
        bottom: 24,
        left: 18,
        width: 42,
        height: 42,
        borderRadius: 21,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
    },
});
