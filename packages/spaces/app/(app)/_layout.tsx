import React from 'react';
import { Stack } from 'expo-router';
import { useAuth } from '@oxyhq/services';
import { Redirect } from 'expo-router';

export default function AppLayout() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) {
    return <Redirect href="/(auth)/sign-in" />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="spaces/[id]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="settings" />
    </Stack>
  );
}
