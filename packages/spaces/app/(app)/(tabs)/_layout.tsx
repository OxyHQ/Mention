import React from 'react';
import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Spaces, SpacesActive } from '@mention/spaces-shared';
import { useAuth } from '@oxyhq/services';

import { useTheme } from '@/hooks/useTheme';
import { useIsScreenNotMobile } from '@/hooks/useMediaQuery';
import { AnimatedTabBar } from '@/components/AnimatedTabBar';
import Avatar from '@/components/Avatar';

export default function TabsLayout() {
  const theme = useTheme();
  const isScreenNotMobile = useIsScreenNotMobile();
  const { user } = useAuth();

  return (
    <Tabs
      tabBar={isScreenNotMobile ? undefined : (props) => <AnimatedTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textSecondary,
        tabBarStyle: isScreenNotMobile ? { display: 'none' } : undefined,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Spaces',
          tabBarIcon: ({ focused, color, size }) =>
            focused
              ? <SpacesActive color={color} size={size} />
              : <Spaces color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="search" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Notifications',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="notifications-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ focused, size }) => (
            <View style={{
              borderRadius: size / 2 + 1,
              borderWidth: focused ? 2 : 0,
              borderColor: theme.colors.primary,
              padding: focused ? 0 : 2,
            }}>
              <Avatar source={user?.avatar} size={size - 2} shape="circle" />
            </View>
          ),
        }}
      />
    </Tabs>
  );
}
