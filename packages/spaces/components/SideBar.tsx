import React, { useState, useMemo } from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { SpacesActive } from '@mention/spaces-shared';
import { useAuth } from '@oxyhq/services';
import { Home, HomeActive } from '@/assets/icons/home-icon';
import { Search, SearchActive } from '@/assets/icons/search-icon';
import { Bell, BellActive } from '@/assets/icons/bell-icon';
import { User, UserActive } from '@/assets/icons/user-icon';
import { Gear, GearActive } from '@/assets/icons/gear-icon';

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
  const { user } = useAuth();

  if (!isScreenNotMobile) return null;

  const isHome = pathname === '/' || pathname === '/(tabs)' || pathname === '/(app)/(tabs)';
  const profileHref = user?.username ? `/@${user.username}` : '/profile';
  const isProfileActive = pathname === '/profile' || pathname?.startsWith('/@');

  const navItems = [
    {
      text: 'Home',
      href: '/',
      icon: (color: string) =>
        isHome ? <HomeActive size={20} color={color} /> : <Home size={20} color={color} />,
      isActive: isHome,
    },
    {
      text: 'Explore',
      href: '/explore',
      icon: (color: string) =>
        pathname === '/explore' ? <SearchActive size={20} color={color} /> : <Search size={20} color={color} />,
      isActive: pathname === '/explore',
    },
    {
      text: 'Notifications',
      href: '/notifications',
      icon: (color: string) =>
        pathname === '/notifications' ? <BellActive size={20} color={color} /> : <Bell size={20} color={color} />,
      isActive: pathname === '/notifications',
    },
    {
      text: 'Profile',
      href: profileHref,
      icon: (color: string) =>
        isProfileActive ? <UserActive size={20} color={color} /> : <User size={20} color={color} />,
      isActive: isProfileActive,
    },
    {
      text: 'Settings',
      href: '/settings',
      icon: (color: string) =>
        pathname.startsWith('/settings') ? <GearActive size={20} color={color} /> : <Gear size={20} color={color} />,
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
