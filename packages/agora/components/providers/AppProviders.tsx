import React, { memo, useMemo, useCallback } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider } from '@oxyhq/services';
import { OxyServices } from '@oxyhq/core';
import { AgoraProvider, LiveRoomProvider } from '@mention/agora-shared';
import { ToastOutlet } from '@oxyhq/bloom/toast';
import { BloomThemeProvider } from '@oxyhq/bloom';

import { OXY_CLIENT_ID } from '@/config';
import { agoraConfig } from '@/lib/agoraConfig';
import { roomQueryKeys } from '@/hooks/useRoomsQuery';

let KeyboardProvider: React.ComponentType<{ children: React.ReactNode }> = ({ children }) => <>{children}</>;
try {
  KeyboardProvider = require('react-native-keyboard-controller').KeyboardProvider;
} catch {}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 2 * 60 * 1000, retry: 1 },
  },
});

interface AppProvidersProps {
  children: React.ReactNode;
  oxyServices: OxyServices;
}

function AgoraProviderWithInvalidation({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const onRoomChanged = useCallback((roomId: string) => {
    qc.invalidateQueries({ queryKey: roomQueryKeys.all });
  }, [qc]);
  const config = useMemo(() => ({ ...agoraConfig, onRoomChanged }), [onRoomChanged]);
  return <AgoraProvider config={config}>{children}</AgoraProvider>;
}

export const AppProviders = memo(function AppProviders({
  children,
  oxyServices,
}: AppProvidersProps) {
  return (
    <BloomThemeProvider
      defaultMode="system"
      defaultColorPreset="yellow"
      fonts={false}
    >
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <KeyboardProvider>
            <QueryClientProvider client={queryClient}>
              <OxyProvider
                oxyServices={oxyServices}
                clientId={OXY_CLIENT_ID}
                storageKeyPrefix="agora"
              >
                <AgoraProviderWithInvalidation>
                  <LiveRoomProvider>
                    {children}
                    <StatusBar style="auto" />
                    <ToastOutlet />
                  </LiveRoomProvider>
                </AgoraProviderWithInvalidation>
              </OxyProvider>
            </QueryClientProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </BloomThemeProvider>
  );
});
