import React, { useRef, useEffect, useLayoutEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, useAnimatedScrollHandler } from 'react-native-reanimated';
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
    instanceId?: string; // Unique identifier to persist state across remounts
}

// Module-level store to persist previous tab ID and position across remounts
const previousTabStore = new Map<string, { tabId: string | null; position: number; width: number }>();

const AnimatedTabBar: React.FC<AnimatedTabBarProps> = ({
    tabs,
    activeTabId,
    onTabPress,
    scrollEnabled = false,
    style,
    instanceId = 'default',
}) => {
    const theme = useTheme();
    // Initialize shared values from stored state if available
    const storedState = previousTabStore.get(instanceId);
    const indicatorPosition = useSharedValue(storedState?.position ?? 0);
    const indicatorWidth = useSharedValue(storedState?.width ?? 0);
    const scrollOffset = useSharedValue(0);
    const tabLayouts = useRef<{ [key: string]: { x: number; width: number; textWidth: number } }>({});
    const scrollRef = useRef<Animated.ScrollView>(null);
    const [layoutReady, setLayoutReady] = useState(false);

    const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);

    // Track scroll offset when scrolling horizontally
    const scrollHandler = useAnimatedScrollHandler({
        onScroll: (event) => {
            scrollOffset.value = event.contentOffset.x;
        },
    });

    // Update indicator position when active tab changes
    useLayoutEffect(() => {
        const layout = tabLayouts.current[activeTabId];

        if (!layout || !layout.textWidth || layout.width === 0 || layout.x < 0) {
            // Wait for layout to be measured - will be updated by onLayout callbacks
            return;
        }

        const padding = 16;
        const indicatorWidthValue = layout.textWidth + padding;
        // Center the indicator under the text
        // x is relative to the container, so we use it directly
        const basePosition = layout.x + (layout.width / 2) - (indicatorWidthValue / 2);

        // Get previous state from module-level store (persists across remounts)
        const previousState = previousTabStore.get(instanceId);
        const previousActiveTabId = previousState?.tabId || null;

        // Always animate unless this is the very first render
        const shouldAnimate = previousActiveTabId !== null && previousActiveTabId !== activeTabId;

        if (shouldAnimate) {
            // Animate to new position from current position (which was restored from store)
            indicatorPosition.value = withTiming(basePosition, {
                duration: 250,
            });
            indicatorWidth.value = withTiming(indicatorWidthValue, { duration: 250 });
        } else {
            // First render: set immediately without animation
            indicatorPosition.value = basePosition;
            indicatorWidth.value = indicatorWidthValue;
        }

        // Always update previous state in module-level store after setting position
        previousTabStore.set(instanceId, {
            tabId: activeTabId,
            position: basePosition,
            width: indicatorWidthValue,
        });
    }, [activeTabId, indicatorPosition, indicatorWidth, layoutReady, instanceId]);

    const animatedIndicatorStyle = useAnimatedStyle(() => {
        // Adjust indicator position by subtracting scroll offset when scrollEnabled
        const adjustedPosition = scrollEnabled
            ? indicatorPosition.value - scrollOffset.value
            : indicatorPosition.value;

        // Ensure minimum width so indicator is always visible
        const width = Math.max(indicatorWidth.value, 20);

        return {
            transform: [{ translateX: adjustedPosition }],
            width: width,
            opacity: width > 0 ? 1 : 0,
        };
    });

    const Container = scrollEnabled ? Animated.ScrollView : View;
    const containerProps = scrollEnabled
        ? {
            horizontal: true,
            showsHorizontalScrollIndicator: false,
            ref: scrollRef,
            onScroll: scrollHandler,
            scrollEventThrottle: 16,
        }
        : {};

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.background, borderBottomColor: theme.colors.border }, style]}>
            <Container style={styles.tabsContainer} {...containerProps}>
                {tabs.map((tab, index) => (
                    <TouchableOpacity
                        key={tab.id}
                        style={styles.tab}
                        onPress={() => onTabPress(tab.id)}
                        onLayout={(event) => {
                            const { x, width } = event.nativeEvent.layout;
                            // Initialize layout info if not exists
                            if (!tabLayouts.current[tab.id]) {
                                tabLayouts.current[tab.id] = {
                                    x,
                                    width,
                                    textWidth: 0, // Will be updated by text onLayout
                                };
                            } else {
                                // Update x and width
                                tabLayouts.current[tab.id].x = x;
                                tabLayouts.current[tab.id].width = width;
                            }

                            // Force re-render to trigger useLayoutEffect if this is the active tab
                            if (tab.id === activeTabId && tabLayouts.current[tab.id].textWidth > 0) {
                                // Trigger update by updating state
                                setLayoutReady(prev => !prev);
                            }
                        }}
                    >
                        <Text
                            style={[
                                styles.tabText,
                                { color: theme.colors.textSecondary },
                                activeTabId === tab.id && [styles.activeTabText, { color: theme.colors.primary }],
                            ]}
                            numberOfLines={1}
                            onLayout={(event) => {
                                const { width: textWidth } = event.nativeEvent.layout;
                                // Update text width in layout info
                                if (!tabLayouts.current[tab.id]) {
                                    tabLayouts.current[tab.id] = {
                                        x: 0,
                                        width: 0,
                                        textWidth,
                                    };
                                } else {
                                    tabLayouts.current[tab.id].textWidth = textWidth;
                                }

                                // Force re-render to trigger useLayoutEffect if this is the active tab
                                if (tab.id === activeTabId && tabLayouts.current[tab.id].width > 0 && tabLayouts.current[tab.id].x >= 0) {
                                    // Trigger update by updating state
                                    setLayoutReady(prev => !prev);
                                }
                            }}
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
        borderTopWidth: 0,
        borderBottomWidth: 1,
    },
    tabsContainer: {
        flexDirection: 'row',
    },
    tab: {
        alignItems: 'center',
        paddingTop: 8,
        paddingBottom: 16,
        paddingHorizontal: 20,
        minWidth: 80,
    },
    tabText: {
        fontSize: 15,
        fontWeight: '500',
    },
    activeTabText: {
        fontWeight: '700',
    },
    indicator: {
        position: 'absolute',
        bottom: 0,
        height: 2,
        borderTopLeftRadius: 4,
        borderTopRightRadius: 4,
    },
});

