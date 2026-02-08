import React from 'react';
import { Platform } from 'react-native';
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
        tabBarLabelStyle: isScreenNotMobile ? undefined : {
          fontSize: 11,
          fontWeight: '600',
        },
        tabBarStyle: isScreenNotMobile
          ? { display: 'none' }
          : {
              position: 'absolute',
              bottom: 12,
              left: 16,
              right: 16,
              height: 56,
              borderRadius: 28,
              backgroundColor: theme.colors.card,
              borderTopWidth: 0,
              paddingBottom: 0,
              ...(Platform.OS === 'web' ? {
                boxShadow: `0 2px 16px ${theme.colors.shadow}`,
              } : {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.15,
                shadowRadius: 12,
                elevation: 8,
              }),
            },
        tabBarItemStyle: isScreenNotMobile ? undefined : {
          paddingVertical: 4,
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
