import React, { useRef, useLayoutEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, ScrollView } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, useAnimatedScrollHandler } from 'react-native-reanimated';
import { cn } from '@/lib/utils';

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
    instanceId?: string;
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
    const storedState = previousTabStore.get(instanceId);
    const indicatorPosition = useSharedValue(storedState?.position ?? 0);
    const indicatorWidth = useSharedValue(storedState?.width ?? 0);
    const scrollOffset = useSharedValue(0);
    const tabLayouts = useRef<{ [key: string]: { x: number; width: number; textWidth: number } }>({});
    const scrollRef = useRef<ScrollView>(null);
    const animatedScrollRef = useRef<Animated.ScrollView>(null);
    const [layoutReady, setLayoutReady] = useState(false);
    const containerWidthRef = useRef(0);

    // Track scroll offset for indicator adjustment
    const scrollHandler = useAnimatedScrollHandler({
        onScroll: (event) => {
            scrollOffset.value = event.contentOffset.x;
        },
    });

    // Update indicator position and auto-scroll to active tab
    useLayoutEffect(() => {
        const layout = tabLayouts.current[activeTabId];
        if (!layout || !layout.textWidth || layout.width === 0 || layout.x < 0) return;

        const padding = 16;
        const indicatorWidthValue = layout.textWidth + padding;
        const basePosition = layout.x + (layout.width / 2) - (indicatorWidthValue / 2);

        const previousState = previousTabStore.get(instanceId);
        const previousActiveTabId = previousState?.tabId || null;
        const shouldAnimate = previousActiveTabId !== null && previousActiveTabId !== activeTabId;

        if (shouldAnimate) {
            indicatorPosition.value = withTiming(basePosition, { duration: 250 });
            indicatorWidth.value = withTiming(indicatorWidthValue, { duration: 250 });
        } else {
            indicatorPosition.value = basePosition;
            indicatorWidth.value = indicatorWidthValue;
        }

        previousTabStore.set(instanceId, {
            tabId: activeTabId,
            position: basePosition,
            width: indicatorWidthValue,
        });

        // Auto-scroll to keep active tab centered
        if (scrollEnabled) {
            const ref = scrollRef.current || animatedScrollRef.current;
            if (ref) {
                const containerWidth = containerWidthRef.current || 300;
                const scrollTo = Math.max(0, layout.x + layout.width / 2 - containerWidth / 2);
                (ref as any).scrollTo?.({ x: scrollTo, animated: shouldAnimate });
            }
        }
    }, [activeTabId, indicatorPosition, indicatorWidth, layoutReady, instanceId, scrollEnabled]);

    const animatedIndicatorStyle = useAnimatedStyle(() => {
        const adjustedPosition = scrollEnabled
            ? indicatorPosition.value - scrollOffset.value
            : indicatorPosition.value;
        const width = Math.max(indicatorWidth.value, 20);
        return {
            transform: [{ translateX: adjustedPosition }],
            width,
            opacity: width > 0 ? 1 : 0,
        };
    });

    const tabItems = tabs.map((tab) => (
        <TouchableOpacity
            key={tab.id}
            className="items-center py-2.5 px-3 min-w-[60px]"
            onPress={() => onTabPress(tab.id)}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: activeTabId === tab.id }}
            onLayout={(event) => {
                const { x, width } = event.nativeEvent.layout;
                if (!tabLayouts.current[tab.id]) {
                    tabLayouts.current[tab.id] = { x, width, textWidth: 0 };
                } else {
                    tabLayouts.current[tab.id].x = x;
                    tabLayouts.current[tab.id].width = width;
                }
                if (tab.id === activeTabId && tabLayouts.current[tab.id].textWidth > 0) {
                    setLayoutReady(prev => !prev);
                }
            }}
        >
            <Text
                className={cn(
                    "text-[15px] font-medium text-muted-foreground",
                    activeTabId === tab.id && "font-bold text-primary"
                )}
                numberOfLines={1}
                onLayout={(event) => {
                    const { width: textWidth } = event.nativeEvent.layout;
                    if (!tabLayouts.current[tab.id]) {
                        tabLayouts.current[tab.id] = { x: 0, width: 0, textWidth };
                    } else {
                        tabLayouts.current[tab.id].textWidth = textWidth;
                    }
                    if (tab.id === activeTabId && tabLayouts.current[tab.id].width > 0 && tabLayouts.current[tab.id].x >= 0) {
                        setLayoutReady(prev => !prev);
                    }
                }}
            >
                {tab.label}
            </Text>
        </TouchableOpacity>
    ));

    return (
        <View
            className="relative border-b border-border bg-background"
            style={style}
            onLayout={(e) => { containerWidthRef.current = e.nativeEvent.layout.width; }}
        >
            {scrollEnabled ? (
                <Animated.ScrollView
                    ref={animatedScrollRef}
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    onScroll={scrollHandler}
                    scrollEventThrottle={16}
                    bounces={false}
                    overScrollMode="never"
                    contentContainerStyle={styles.scrollContent}
                >
                    {tabItems}
                </Animated.ScrollView>
            ) : (
                <View className="flex-row">
                    {tabItems}
                </View>
            )}
            <Animated.View
                className="absolute bottom-0 h-0.5 rounded-t bg-primary"
                style={animatedIndicatorStyle}
            />
        </View>
    );
};

export default AnimatedTabBar;

const styles = StyleSheet.create({
    scrollContent: {
        flexDirection: 'row',
    },
});
