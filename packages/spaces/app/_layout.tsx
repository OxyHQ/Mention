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
      const fontMap: Record<string, any> = {};
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
    const textProps = (Text as any).defaultProps || {};
    (Text as any).defaultProps = {
      ...textProps,
      style: [textProps.style, defaultTextStyle],
    };
    const textInputProps = (TextInput as any).defaultProps || {};
    (TextInput as any).defaultProps = {
      ...textInputProps,
      style: [textInputProps.style, defaultTextStyle],
    };
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
