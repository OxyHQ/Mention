import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { ArrowUp } from '@/assets/icons/arrow-up-icon';
import { useLayoutScroll } from '@/context/LayoutScrollContext';

function WebScrollToTopButton() {
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

    // Render as a raw DOM element to avoid RN Web transform stacking context issues
    return (
        <View
            style={[
                styles.button,
                {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                },
            ]}
            // @ts-ignore web onClick
            onClick={scrollToTop}
        >
            <ArrowUp size={18} color={theme.colors.textSecondary} />
        </View>
    );
}

export function ScrollToTopButton() {
    if (Platform.OS !== 'web') return null;
    return <WebScrollToTopButton />;
}

const styles = StyleSheet.create({
    button: {
        position: 'fixed' as any,
        bottom: 30,
        left: 18,
        width: 42,
        height: 42,
        borderRadius: 21,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        cursor: 'pointer' as any,
    },
});
