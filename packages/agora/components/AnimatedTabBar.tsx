import React, { useCallback, useEffect } from 'react';
import { View, Text, Pressable, Platform, LayoutChangeEvent, type ViewStyle } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { BlurView } from 'expo-blur';

import { useTheme } from '@/hooks/useTheme';

const SPRING_CONFIG = {
  damping: 20,
  stiffness: 200,
  mass: 0.5,
};

export function AnimatedTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const theme = useTheme();
  const tabCount = state.routes.length;
  const tabWidth = useSharedValue(0);
  const indicatorX = useSharedValue(0);
  const barWidth = useSharedValue(0);

  const onBarLayout = useCallback((e: LayoutChangeEvent) => {
    const width = e.nativeEvent.layout.width;
    barWidth.value = width;
    tabWidth.value = width / tabCount;
    indicatorX.value = withSpring(
      (width / tabCount) * state.index,
      SPRING_CONFIG,
    );
  }, [tabCount, state.index]);

  useEffect(() => {
    if (tabWidth.value > 0) {
      indicatorX.value = withSpring(
        tabWidth.value * state.index,
        SPRING_CONFIG,
      );
    }
  }, [state.index]);

  const indicatorStyle = useAnimatedStyle(() => ({
    position: 'absolute',
    top: 4,
    bottom: 4,
    width: tabWidth.value ? tabWidth.value - 8 : 0,
    left: indicatorX.value + 4,
    borderRadius: 22,
    backgroundColor: `${theme.colors.primary}1A`,
  }));

  const containerStyle: ViewStyle = {
    position: 'absolute',
    bottom: 12,
    left: 16,
    right: 16,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  };
  if (Platform.OS === 'web') {
    Object.assign(containerStyle, {
      boxShadow: `0 2px 16px ${theme.colors.shadow}`,
    });
  } else {
    containerStyle.shadowColor = '#000';
    containerStyle.shadowOffset = { width: 0, height: 4 };
    containerStyle.shadowOpacity = 0.15;
    containerStyle.shadowRadius = 12;
    containerStyle.elevation = 8;
  }

  const innerContent = (
    <>
      <Animated.View style={indicatorStyle} />
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const isFocused = state.index === index;

        const color = isFocused ? theme.colors.primary : theme.colors.textSecondary;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });
          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name, route.params);
          }
        };

        const icon = options.tabBarIcon?.({
          focused: isFocused,
          color,
          size: 22,
        });

        const pressableStyle: ViewStyle = {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
        };
        if (Platform.OS === 'web') {
          Object.assign(pressableStyle, { cursor: 'pointer' });
        }

        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            style={pressableStyle}
          >
            {icon}
            <Text
              style={{
                fontSize: 10,
                fontWeight: isFocused ? '700' : '500',
                color,
                marginTop: 2,
              }}
              numberOfLines={1}
            >
              {typeof options.title === 'string' ? options.title : route.name}
            </Text>
          </Pressable>
        );
      })}
    </>
  );

  if (Platform.OS === 'web') {
    const webContainerStyle: ViewStyle = {
      ...containerStyle,
      backgroundColor: `${theme.colors.card}CC`,
      flexDirection: 'row',
      alignItems: 'center',
    };
    Object.assign(webContainerStyle, {
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
    });

    return (
      <View
        style={webContainerStyle}
        onLayout={onBarLayout}
      >
        {innerContent}
      </View>
    );
  }

  return (
    <View style={containerStyle} onLayout={onBarLayout}>
      <BlurView
        intensity={80}
        tint={theme.isDark ? 'dark' : 'light'}
        experimentalBlurMethod="dimezisBlurView"
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        {innerContent}
      </BlurView>
    </View>
  );
}
