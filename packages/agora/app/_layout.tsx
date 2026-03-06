import React, { useEffect, useMemo } from 'react';
import { Platform, Text, TextInput } from 'react-native';
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
  const [fontsLoaded] = useFonts(
    useMemo(() => {
      const fontMap: Record<string, number> = {};
      const InterVariable = require('@/assets/fonts/inter/InterVariable.ttf');

      ['Thin', 'ExtraLight', 'Light', 'Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black'].forEach(weight => {
        fontMap[`Inter-${weight}`] = InterVariable;
      });

      fontMap['Inter'] = InterVariable;
      return fontMap;
    }, [])
  );

  const oxyServices = useMemo(
    () => new OxyServices({ baseURL: OXY_BASE_URL }),
    []
  );

  // Set Inter as the default font for all Text and TextInput components
  useEffect(() => {
    if (!fontsLoaded) return;
    const defaultTextStyle = { fontFamily: 'Inter' };

    const currentTextDefaults = Object.getOwnPropertyDescriptor(Text, 'defaultProps')?.value ?? {};
    Object.defineProperty(Text, 'defaultProps', {
      value: { ...currentTextDefaults, style: [currentTextDefaults.style, defaultTextStyle] },
      writable: true,
      configurable: true,
    });

    const currentInputDefaults = Object.getOwnPropertyDescriptor(TextInput, 'defaultProps')?.value ?? {};
    Object.defineProperty(TextInput, 'defaultProps', {
      value: { ...currentInputDefaults, style: [currentInputDefaults.style, defaultTextStyle] },
      writable: true,
      configurable: true,
    });
  }, [fontsLoaded]);

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
