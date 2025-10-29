import React, { useRef, useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, ScrollView } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { colors } from '@/styles/colors';
import { useTheme } from '@/hooks/useTheme';

interface Tab {
    id: string;
    label: string;
}

interface AnimatedTabBarProps {
    tabs: Tab[];
    activeTabId: string;
    onTabPress: (tabId: string) => void;
    scrollEnabled?: boolean;
    style?: any;
}

const AnimatedTabBar: React.FC<AnimatedTabBarProps> = ({
    tabs,
    activeTabId,
    onTabPress,
    scrollEnabled = false,
    style,
}) => {
    const theme = useTheme();
    const indicatorPosition = useSharedValue(0);
    const indicatorWidth = useSharedValue(0);
    const tabRefs = useRef<{ [key: string]: View }>({});
    const scrollRef = useRef<ScrollView>(null);

    const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);

    // Animate indicator when active tab changes
    useEffect(() => {
        const updateIndicator = async () => {
            const activeTab = tabRefs.current[activeTabId];
            if (!activeTab) return;

            activeTab.measure((x, y, width, height, pageX, pageY) => {
                indicatorPosition.value = withTiming(x + width / 2 - 15, {
                    duration: 250,
                });
                indicatorWidth.value = withTiming(30, { duration: 250 });
            });
        };

        // Small delay to ensure layout is complete
        const timeout = setTimeout(updateIndicator, 50);
        return () => clearTimeout(timeout);
    }, [activeTabId, tabs, indicatorPosition, indicatorWidth]);

    const animatedIndicatorStyle = useAnimatedStyle(() => {
        return {
            transform: [{ translateX: indicatorPosition.value }],
            width: indicatorWidth.value,
        };
    });

    const Container = scrollEnabled ? ScrollView : View;
    const containerProps = scrollEnabled
        ? {
            horizontal: true,
            showsHorizontalScrollIndicator: false,
            ref: scrollRef,
        }
        : {};

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.background, borderBottomColor: theme.colors.border }, style]}>
            <Container style={styles.tabsContainer} {...containerProps}>
                {tabs.map((tab, index) => (
                    <TouchableOpacity
                        key={tab.id}
                        ref={(ref) => {
                            if (ref) tabRefs.current[tab.id] = ref;
                        }}
                        style={styles.tab}
                        onPress={() => onTabPress(tab.id)}
                    >
                        <Text
                            style={[
                                styles.tabText,
                                { color: theme.colors.textSecondary },
                                activeTabId === tab.id && [styles.activeTabText, { color: theme.colors.primary }],
                            ]}
                            numberOfLines={1}
                        >
                            {tab.label}
                        </Text>
                    </TouchableOpacity>
                ))}
            </Container>
            <Animated.View style={[styles.indicator, { backgroundColor: theme.colors.primary }, animatedIndicatorStyle]} />
        </View>
    );
};

export default AnimatedTabBar;

const styles = StyleSheet.create({
    container: {
        position: 'relative',
        backgroundColor: 'white',
        borderBottomWidth: 1,
        borderBottomColor: "#2F3336",
    },
    tabsContainer: {
        flexDirection: 'row',
    },
    tab: {
        alignItems: 'center',
        paddingVertical: 16,
        paddingHorizontal: 20,
        minWidth: 80,
    },
    tabText: {
        fontSize: 15,
        fontWeight: '500',
        color: "#71767B",
    },
    activeTabText: {
        color: "#d169e5",
        fontWeight: '700',
    },
    indicator: {
        position: 'absolute',
        bottom: 0,
        height: 2,
        backgroundColor: "#d169e5",
        borderRadius: 1,
    },
});

