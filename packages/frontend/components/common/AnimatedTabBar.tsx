import React, { useRef, useEffect } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, useAnimatedScrollHandler } from 'react-native-reanimated';
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
    const scrollOffset = useSharedValue(0);
    const tabRefs = useRef<{ [key: string]: View }>({});
    const textRefs = useRef<{ [key: string]: Text }>({});
    const scrollRef = useRef<Animated.ScrollView>(null);

    const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);

    // Track scroll offset when scrolling horizontally
    const scrollHandler = useAnimatedScrollHandler({
        onScroll: (event) => {
            scrollOffset.value = event.contentOffset.x;
        },
    });

    // Animate indicator when active tab changes
    useEffect(() => {
        const updateIndicator = async () => {
            const activeTab = tabRefs.current[activeTabId];
            const activeText = textRefs.current[activeTabId];
            if (!activeTab || !activeText) return;

            // Measure text layout relative to tab container
            activeText.measureLayout(
                activeTab,
                (textX, textY, textWidth, textHeight) => {
                    // Measure tab container position relative to ScrollView/content
                    activeTab.measure((x, y, width, height, pageX, pageY) => {
                        // Add padding on each side (8px on each side = 16px total)
                        const padding = 16;
                        const indicatorWidthValue = textWidth + padding;
                        
                        // Center the indicator under the text
                        // textX is relative to tab container, so add it to tab's x position
                        const textCenterX = x + textX + textWidth / 2;
                        const basePosition = textCenterX - indicatorWidthValue / 2;
                        
                        indicatorPosition.value = withTiming(basePosition, {
                            duration: 250,
                        });
                        indicatorWidth.value = withTiming(indicatorWidthValue, { duration: 250 });
                    },
                    () => {
                        // Fallback: if measureLayout fails, use simple measure
                        activeText.measure((textX, textY, textWidth, textHeight, textPageX, textPageY) => {
                            activeTab.measure((x, y, width, height, pageX, pageY) => {
                                const padding = 16;
                                const indicatorWidthValue = textWidth + padding;
                                const basePosition = x + width / 2 - indicatorWidthValue / 2;
                                
                                indicatorPosition.value = withTiming(basePosition, {
                                    duration: 250,
                                });
                                indicatorWidth.value = withTiming(indicatorWidthValue, { duration: 250 });
                            });
                        });
                    }
                );
            });
        };

        // Small delay to ensure layout is complete
        const timeout = setTimeout(updateIndicator, 50);
        return () => clearTimeout(timeout);
    }, [activeTabId, tabs, indicatorPosition, indicatorWidth]);

    const animatedIndicatorStyle = useAnimatedStyle(() => {
        // Adjust indicator position by subtracting scroll offset when scrollEnabled
        const adjustedPosition = scrollEnabled 
            ? indicatorPosition.value - scrollOffset.value 
            : indicatorPosition.value;
        
        return {
            transform: [{ translateX: adjustedPosition }],
            width: indicatorWidth.value,
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
                        ref={(ref) => {
                            if (ref) tabRefs.current[tab.id] = ref;
                        }}
                        style={styles.tab}
                        onPress={() => onTabPress(tab.id)}
                    >
                        <Text
                            ref={(ref) => {
                                if (ref) textRefs.current[tab.id] = ref;
                            }}
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

