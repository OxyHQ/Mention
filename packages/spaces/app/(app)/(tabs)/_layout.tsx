import React from 'react';
import { View } from 'react-native';
import { Tabs } from 'expo-router';
import { Spaces, SpacesActive } from '@mention/spaces-shared';
import { useAuth } from '@oxyhq/services';
import { Search, SearchActive } from '@/assets/icons/search-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';

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
          tabBarIcon: ({ focused, color, size }) =>
            focused
              ? <SearchActive color={color} size={size} />
              : <Search color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Notifications',
          tabBarIcon: ({ focused, color, size }) =>
            focused
              ? <BellActive color={color} size={size} />
              : <Bell color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          href: user?.username ? `/(app)/@${user.username}` as any : undefined,
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
