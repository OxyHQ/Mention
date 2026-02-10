import React, { useState, useMemo } from 'react';
import { View, Text, Pressable, Platform, type ViewStyle } from 'react-native';
import { useRouter, usePathname, type Href } from 'expo-router';
import { AgoraActive } from '@mention/agora-shared';
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
  href: Href;
  isActive: boolean;
  isExpanded: boolean;
  theme: ReturnType<typeof useTheme>;
}

function SideBarItem({ icon, text, href, isActive, isExpanded, theme }: SideBarItemProps) {
  const router = useRouter();
  const [isHovered, setIsHovered] = useState(false);

  const itemStyle = useMemo(() => {
    const baseStyle: ViewStyle = {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: isExpanded ? 'flex-start' : 'center',
      paddingVertical: 8,
      paddingHorizontal: isExpanded ? 12 : 0,
      width: isExpanded ? undefined : 40,
      height: isExpanded ? undefined : 40,
      marginVertical: 1,
      borderRadius: 20,
      alignSelf: isExpanded ? 'stretch' : 'center',
      backgroundColor: isActive
        ? `${theme.colors.primary}1A`
        : isHovered
          ? `${theme.colors.primary}14`
          : 'transparent',
    };
    if (Platform.OS === 'web') {
      Object.assign(baseStyle, { cursor: 'pointer', transition: 'background-color 150ms ease' });
    }
    return baseStyle;
  }, [isActive, isHovered, isExpanded, theme.colors.primary]);

  return (
    <Pressable
      onPress={() => router.push(href)}
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
  const profileHref: Href = user?.username
    ? { pathname: '/(app)/(tabs)/[username]', params: { username: '@' + user.username } }
    : '/profile';
  const isProfileActive = pathname === '/profile' || pathname?.startsWith('/@');

  const navItems: Array<{ text: string; href: Href; icon: (color: string) => React.ReactNode; isActive: boolean }> = [
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

  const sidebarStyle: ViewStyle = {
    width: isExpanded ? 180 : 52,
    backgroundColor: theme.colors.background,
    paddingVertical: 12,
    paddingHorizontal: 6,
  };
  if (Platform.OS === 'web') {
    Object.assign(sidebarStyle, {
      position: 'sticky',
      top: 0,
      height: '100vh',
      overflowX: 'hidden',
    });
  } else {
    Object.assign(sidebarStyle, {
      height: '100%',
    });
  }

  return (
    <View style={sidebarStyle}>
      <View style={{
        paddingHorizontal: isExpanded ? 12 : 0,
        paddingVertical: 8,
        marginBottom: 4,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: isExpanded ? 'flex-start' : 'center',
      }}>
        <AgoraActive color={theme.colors.primary} size={24} />
        {isExpanded && (
          <Text style={{
            marginLeft: 10,
            fontSize: 17,
            fontWeight: '700',
            color: theme.colors.primary,
          }}>
            Agora
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
