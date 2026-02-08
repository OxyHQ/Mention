import React, { useState, useRef, useMemo, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Spaces, SpacesActive } from '@mention/spaces-shared';

import { useTheme } from '@/hooks/useTheme';
import { useIsScreenNotMobile } from '@/hooks/useMediaQuery';

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
    paddingVertical: 12,
    paddingHorizontal: isExpanded ? 16 : 12,
    marginVertical: 2,
    borderRadius: 12,
    backgroundColor: isActive
      ? `${theme.colors.primary}1A`
      : isHovered
        ? `${theme.colors.primary}14`
        : 'transparent',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' as any, transition: 'background-color 200ms ease' } : {}),
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
            marginLeft: 16,
            fontSize: 16,
            fontWeight: isActive ? '700' : '400',
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
  const theme = useTheme();
  const pathname = usePathname();
  const [isExpanded, setIsExpanded] = useState(false);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleHoverIn = useCallback(() => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    setIsExpanded(true);
  }, []);

  const handleHoverOut = useCallback(() => {
    hoverTimeout.current = setTimeout(() => setIsExpanded(false), 200);
  }, []);

  if (!isScreenNotMobile) return null;

  const navItems = [
    {
      text: 'Home',
      href: '/',
      icon: (color: string) =>
        pathname === '/' || pathname === '/(tabs)'
          ? <Ionicons name="home" size={24} color={color} />
          : <Ionicons name="home-outline" size={24} color={color} />,
      isActive: pathname === '/' || pathname === '/(tabs)' || pathname === '/(app)/(tabs)',
    },
    {
      text: 'Explore',
      href: '/explore',
      icon: (color: string) =>
        pathname === '/explore'
          ? <Ionicons name="search" size={24} color={color} />
          : <Ionicons name="search-outline" size={24} color={color} />,
      isActive: pathname === '/explore',
    },
    {
      text: 'Notifications',
      href: '/notifications',
      icon: (color: string) =>
        pathname === '/notifications'
          ? <Ionicons name="notifications" size={24} color={color} />
          : <Ionicons name="notifications-outline" size={24} color={color} />,
      isActive: pathname === '/notifications',
    },
    {
      text: 'Profile',
      href: '/profile',
      icon: (color: string) =>
        pathname === '/profile'
          ? <Ionicons name="person" size={24} color={color} />
          : <Ionicons name="person-outline" size={24} color={color} />,
      isActive: pathname === '/profile',
    },
    {
      text: 'Settings',
      href: '/settings',
      icon: (color: string) =>
        pathname.startsWith('/settings')
          ? <Ionicons name="settings" size={24} color={color} />
          : <Ionicons name="settings-outline" size={24} color={color} />,
      isActive: pathname.startsWith('/settings'),
    },
  ];

  const styles = StyleSheet.create({
    container: {
      width: isExpanded ? 240 : 60,
      backgroundColor: theme.colors.background,
      paddingVertical: 16,
      paddingHorizontal: 8,
      borderRightWidth: 0.5,
      borderRightColor: theme.colors.border,
      ...(Platform.OS === 'web' ? {
        position: 'sticky' as any,
        top: 0,
        height: '100vh' as any,
        transition: 'width 220ms cubic-bezier(0.4, 0, 0.2, 1)',
        overflowX: 'hidden' as any,
      } : {
        height: '100%',
      }),
    },
    logo: {
      paddingHorizontal: isExpanded ? 16 : 8,
      paddingVertical: 12,
      marginBottom: 8,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
    },
    logoText: {
      marginLeft: 12,
      fontSize: 20,
      fontWeight: '700',
      color: theme.colors.primary,
    },
  });

  return (
    <View
      style={styles.container}
      onPointerEnter={handleHoverIn}
      onPointerLeave={handleHoverOut}
    >
      <View style={styles.logo}>
        <SpacesActive color={theme.colors.primary} size={28} />
        {isExpanded && <Text style={styles.logoText}>Spaces</Text>}
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
