import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Spaces, SpacesActive } from '@mention/spaces-shared';

import { useTheme } from '@/hooks/useTheme';
import { useIsScreenNotMobile } from '@/hooks/useMediaQuery';

export default function TabsLayout() {
  const theme = useTheme();
  const isScreenNotMobile = useIsScreenNotMobile();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textSecondary,
        tabBarStyle: isScreenNotMobile
          ? { display: 'none' }
          : {
              backgroundColor: theme.colors.background,
              borderTopColor: theme.colors.border,
            },
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
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
