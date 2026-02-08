import React, { useState, useMemo } from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SpacesActive } from '@mention/spaces-shared';

import { useTheme } from '@/hooks/useTheme';
import { useIsScreenNotMobile, useIsSidebarExpanded } from '@/hooks/useMediaQuery';

interface SideBarItemProps {
  icon: React.ReactNode;
  text: string;
  href: string;
  isActive: boolean;
  isExpanded: boolean;
  theme: ReturnType<typeof useTheme>;
}

function SideBarItem({ icon, text, href, isActive, isExpanded, theme }: SideBarItemProps) {
  const router = useRouter();
  const [isHovered, setIsHovered] = useState(false);

  const itemStyle = useMemo(() => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: isExpanded ? ('flex-start' as const) : ('center' as const),
    paddingVertical: 8,
    paddingHorizontal: isExpanded ? 12 : 0,
    width: isExpanded ? undefined : 40,
    height: isExpanded ? undefined : 40,
    marginVertical: 1,
    borderRadius: 20,
    alignSelf: isExpanded ? ('stretch' as const) : ('center' as const),
    backgroundColor: isActive
      ? `${theme.colors.primary}1A`
      : isHovered
        ? `${theme.colors.primary}14`
        : 'transparent',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' as any, transition: 'background-color 150ms ease' } : {}),
  }), [isActive, isHovered, isExpanded, theme.colors.primary]);

  return (
    <Pressable
      onPress={() => router.push(href as any)}
      onHoverIn={() => setIsHovered(true)}
      onHoverOut={() => setIsHovered(false)}
      style={itemStyle}
    >
      {icon}
      {isExpanded && (
        <Text
          style={{
            marginLeft: 12,
            fontSize: 14,
            fontWeight: isActive ? '600' : '400',
            color: isActive ? theme.colors.primary : theme.colors.text,
          }}
          numberOfLines={1}
        >
          {text}
        </Text>
      )}
    </Pressable>
  );
}

export function SideBar() {
  const isScreenNotMobile = useIsScreenNotMobile();
  const isExpanded = useIsSidebarExpanded();
  const theme = useTheme();
  const pathname = usePathname();

  if (!isScreenNotMobile) return null;

  const navItems = [
    {
      text: 'Home',
      href: '/',
      icon: (color: string) =>
        pathname === '/' || pathname === '/(tabs)'
          ? <Ionicons name="home" size={20} color={color} />
          : <Ionicons name="home-outline" size={20} color={color} />,
      isActive: pathname === '/' || pathname === '/(tabs)' || pathname === '/(app)/(tabs)',
    },
    {
      text: 'Explore',
      href: '/explore',
      icon: (color: string) =>
        pathname === '/explore'
          ? <Ionicons name="search" size={20} color={color} />
          : <Ionicons name="search-outline" size={20} color={color} />,
      isActive: pathname === '/explore',
    },
    {
      text: 'Notifications',
      href: '/notifications',
      icon: (color: string) =>
        pathname === '/notifications'
          ? <Ionicons name="notifications" size={20} color={color} />
          : <Ionicons name="notifications-outline" size={20} color={color} />,
      isActive: pathname === '/notifications',
    },
    {
      text: 'Profile',
      href: '/profile',
      icon: (color: string) =>
        pathname === '/profile'
          ? <Ionicons name="person" size={20} color={color} />
          : <Ionicons name="person-outline" size={20} color={color} />,
      isActive: pathname === '/profile',
    },
    {
      text: 'Settings',
      href: '/settings',
      icon: (color: string) =>
        pathname.startsWith('/settings')
          ? <Ionicons name="settings" size={20} color={color} />
          : <Ionicons name="settings-outline" size={20} color={color} />,
      isActive: pathname.startsWith('/settings'),
    },
  ];

  return (
    <View
      style={{
        width: isExpanded ? 180 : 52,
        backgroundColor: theme.colors.background,
        paddingVertical: 12,
        paddingHorizontal: 6,
        ...(Platform.OS === 'web' ? {
          position: 'sticky' as any,
          top: 0,
          height: '100vh' as any,
          overflowX: 'hidden' as any,
        } : {
          height: '100%',
        }),
      }}
    >
      <View style={{
        paddingHorizontal: isExpanded ? 12 : 0,
        paddingVertical: 8,
        marginBottom: 4,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: isExpanded ? 'flex-start' : 'center',
      }}>
        <SpacesActive color={theme.colors.primary} size={24} />
        {isExpanded && (
          <Text style={{
            marginLeft: 10,
            fontSize: 17,
            fontWeight: '700',
            color: theme.colors.primary,
          }}>
            Spaces
          </Text>
        )}
      </View>
      {navItems.map((item) => (
        <SideBarItem
          key={item.text}
          icon={item.icon(item.isActive ? theme.colors.primary : theme.colors.icon)}
          text={item.text}
          href={item.href}
          isActive={item.isActive}
          isExpanded={isExpanded}
          theme={theme}
        />
      ))}
    </View>
  );
}
