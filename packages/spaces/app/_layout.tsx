import React, { useEffect, useMemo } from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { OxyServices } from '@oxyhq/core';

import { AppProviders } from '@/components/providers/AppProviders';
import { OXY_BASE_URL } from '@/config';

// Register LiveKit globals on native
if (Platform.OS !== 'web') {
  try {
    const { registerGlobals } = require('@livekit/react-native');
    registerGlobals();
  } catch {}
}

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter: require('@/assets/fonts/inter/InterVariable.ttf'),
  });

  const oxyServices = useMemo(
    () => new OxyServices({ baseURL: OXY_BASE_URL }),
    []
  );

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <AppProviders oxyServices={oxyServices}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
      </Stack>
    </AppProviders>
  );
}
