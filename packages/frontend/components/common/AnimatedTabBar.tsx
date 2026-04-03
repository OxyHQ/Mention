import React, { useRef, useLayoutEffect, useState, useCallback, useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, Platform } from 'react-native';
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

    // Update indicator position and auto-scroll to active tab when it changes
    useLayoutEffect(() => {
        const layout = tabLayouts.current[activeTabId];

        if (!layout || !layout.textWidth || layout.width === 0 || layout.x < 0) {
            return;
        }

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

        // Auto-scroll to keep active tab visible (centered if possible)
        if (scrollEnabled && scrollRef.current) {
            const tabCenter = layout.x + layout.width / 2;
            // Scroll so the tab is roughly centered; ScrollView handles clamping
            const scrollTo = Math.max(0, tabCenter - 150);
            scrollRef.current.scrollTo?.({ x: scrollTo, animated: shouldAnimate });
        }
    }, [activeTabId, indicatorPosition, indicatorWidth, layoutReady, instanceId, scrollEnabled]);

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

    // Mouse drag scrolling for web (makes tab bar draggable without visible scrollbar)
    const dragRef = useRef<{ isDown: boolean; startX: number; scrollLeft: number }>({ isDown: false, startX: 0, scrollLeft: 0 });

    const handleMouseDown = useCallback((e: any) => {
        const el = scrollRef.current?.getScrollableNode?.() ?? scrollRef.current;
        if (!el) return;
        dragRef.current = { isDown: true, startX: e.pageX ?? e.clientX, scrollLeft: el.scrollLeft ?? 0 };
        if (el.style) el.style.cursor = 'grabbing';
    }, []);

    const handleMouseUp = useCallback(() => {
        dragRef.current.isDown = false;
        const el = scrollRef.current?.getScrollableNode?.() ?? scrollRef.current;
        if (el?.style) el.style.cursor = 'grab';
    }, []);

    const handleMouseMove = useCallback((e: any) => {
        if (!dragRef.current.isDown) return;
        e.preventDefault?.();
        const el = scrollRef.current?.getScrollableNode?.() ?? scrollRef.current;
        if (!el) return;
        const x = e.pageX ?? e.clientX;
        const walk = x - dragRef.current.startX;
        el.scrollLeft = dragRef.current.scrollLeft - walk;
    }, []);

    // Attach native mouse events on web for smooth drag
    useEffect(() => {
        if (Platform.OS !== 'web' || !scrollEnabled) return;
        const el = scrollRef.current?.getScrollableNode?.() ?? scrollRef.current;
        if (!el?.addEventListener) return;
        el.style.cursor = 'grab';
        el.addEventListener('mousedown', handleMouseDown);
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            el.removeEventListener('mousedown', handleMouseDown);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [scrollEnabled, handleMouseDown, handleMouseMove, handleMouseUp]);

    const Container = scrollEnabled ? Animated.ScrollView : View;
    const containerProps = scrollEnabled
        ? {
            horizontal: true,
            showsHorizontalScrollIndicator: false,
            ref: scrollRef,
            onScroll: scrollHandler,
            scrollEventThrottle: 16,
            contentContainerStyle: styles.scrollContent,
        }
        : {};

    return (
        <View className="relative border-b border-border bg-background" style={style}>
            <Container className="flex-row" {...containerProps}>
                {tabs.map((tab, index) => (
                    <TouchableOpacity
                        key={tab.id}
                        className="items-center py-2.5 px-3 min-w-[60px]"
                        onPress={() => onTabPress(tab.id)}
                        accessibilityRole="tab"
                        accessibilityLabel={tab.label}
                        accessibilityState={{ selected: activeTabId === tab.id }}
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
                            className={cn(
                                "text-[15px] font-medium text-muted-foreground",
                                activeTabId === tab.id && "font-bold text-primary"
                            )}
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
