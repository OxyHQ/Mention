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
            className="active:opacity-80"
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
                // Position just left of the content column border
                // Content is max 950px centered, so left edge is at 50vw - 475px
                // Place button ~30px to the left of that
                left: 'calc(50vw - 505px)' as any,
            },
            default: {
                position: 'absolute',
                left: 18,
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
