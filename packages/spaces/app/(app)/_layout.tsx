import React, { useMemo, memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { useAuth } from '@oxyhq/services';
import { Redirect } from 'expo-router';

import { SideBar } from '@/components/SideBar';
import { useTheme } from '@/hooks/useTheme';
import { useIsScreenNotMobile } from '@/hooks/useMediaQuery';

interface MainLayoutProps {
  isScreenNotMobile: boolean;
}

const MainLayout: React.FC<MainLayoutProps> = memo(({ isScreenNotMobile }) => {
  const theme = useTheme();

  const styles = useMemo(() => StyleSheet.create({
    outerContainer: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    centeredWrapper: {
      flex: 1,
      flexDirection: 'row',
      maxWidth: isScreenNotMobile ? 1200 : undefined,
      width: '100%',
      marginHorizontal: 'auto',
    },
    mainContent: {
      flex: 1,
      backgroundColor: theme.colors.background,
      ...(isScreenNotMobile ? {
        borderLeftWidth: 0.5,
        borderRightWidth: 0.5,
        borderColor: theme.colors.border,
      } : {}),
    },
  }), [isScreenNotMobile, theme.colors.background, theme.colors.border]);

  return (
    <View style={styles.outerContainer}>
      <View style={styles.centeredWrapper}>
        <SideBar />
        <View style={styles.mainContent}>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="spaces/[id]" options={{ presentation: 'modal' }} />
            <Stack.Screen name="settings/index" />
          </Stack>
        </View>
      </View>
    </View>
  );
});

MainLayout.displayName = 'MainLayout';

export default function AppLayout() {
  const isScreenNotMobile = useIsScreenNotMobile();
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <Redirect href="/(auth)/sign-in" />;
  }

  return <MainLayout isScreenNotMobile={isScreenNotMobile} />;
}
