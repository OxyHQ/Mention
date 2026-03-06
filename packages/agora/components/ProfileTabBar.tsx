import React, { useCallback } from 'react';
import { View, Text, Pressable, LayoutChangeEvent, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';

import { useTheme } from '@/hooks/useTheme';

const SPRING_CONFIG = {
  damping: 20,
  stiffness: 200,
  mass: 0.5,
};

interface Tab {
  id: string;
  label: string;
}

interface ProfileTabBarProps {
  tabs: Tab[];
  activeTab: string;
  onTabPress: (tabId: string) => void;
}

export function ProfileTabBar({ tabs, activeTab, onTabPress }: ProfileTabBarProps) {
  const theme = useTheme();
  const tabWidths = useSharedValue<number[]>([]);
  const tabPositions = useSharedValue<number[]>([]);
  const indicatorX = useSharedValue(0);
  const indicatorW = useSharedValue(0);

  const activeIndex = tabs.findIndex((t) => t.id === activeTab);

  const onTabLayout = useCallback(
    (index: number) => (e: LayoutChangeEvent) => {
      const { x, width } = e.nativeEvent.layout;
      const positions = [...tabPositions.value];
      const widths = [...tabWidths.value];
      positions[index] = x;
      widths[index] = width;
      tabPositions.value = positions;
      tabWidths.value = widths;

      if (index === activeIndex && width > 0) {
        indicatorX.value = withSpring(x, SPRING_CONFIG);
        indicatorW.value = withSpring(width, SPRING_CONFIG);
      }
    },
    [activeIndex],
  );

  React.useEffect(() => {
    const x = tabPositions.value[activeIndex];
    const w = tabWidths.value[activeIndex];
    if (x !== undefined && w !== undefined && w > 0) {
      indicatorX.value = withSpring(x, SPRING_CONFIG);
      indicatorW.value = withSpring(w, SPRING_CONFIG);
    }
  }, [activeIndex]);

  const indicatorStyle = useAnimatedStyle(() => ({
    position: 'absolute' as const,
    top: 2,
    bottom: 2,
    left: indicatorX.value,
    width: indicatorW.value,
    borderRadius: 16,
    backgroundColor: `${theme.colors.primary}1A`,
  }));

  return (
    <View style={[styles.container, { borderBottomColor: theme.colors.border }]}>
      <View style={styles.tabsRow}>
        <Animated.View style={indicatorStyle} />
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTab;
          return (
            <Pressable
              key={tab.id}
              style={styles.tab}
              onPress={() => onTabPress(tab.id)}
              onLayout={onTabLayout(index)}
            >
              <Text
                style={[
                  styles.tabText,
                  {
                    color: isActive ? theme.colors.primary : theme.colors.textSecondary,
                    fontWeight: isActive ? '700' : '500',
                  },
                ]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: 1,
    paddingHorizontal: 8,
  },
  tabsRow: {
    flexDirection: 'row',
    position: 'relative',
  },
  tab: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  tabText: {
    fontSize: 14,
  },
});
