import React, { memo, useEffect } from 'react';
import { Platform } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider, useAuth } from '@oxyhq/services';
import { OxyServices } from '@oxyhq/core';
import { AgoraProvider, LiveSpaceProvider } from '@mention/agora-shared';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Toaster } from 'sonner-native';

import { agoraConfig } from '@/lib/agoraConfig';
import { setOxyServicesRef } from '@/utils/api';

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

function OxyServicesSync({ children }: { children: React.ReactNode }) {
  const { oxyServices } = useAuth();
  useEffect(() => {
    if (oxyServices) setOxyServicesRef(oxyServices);
  }, [oxyServices]);
  return <>{children}</>;
}

export const AppProviders = memo(function AppProviders({
  children,
  oxyServices,
}: AppProvidersProps) {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardProvider>
          <QueryClientProvider client={queryClient}>
            <OxyProvider
              oxyServices={oxyServices}
              storageKeyPrefix="agora"
            >
              <OxyServicesSync>
                <AgoraProvider config={agoraConfig}>
                  <LiveSpaceProvider>
                    <BottomSheetModalProvider>
                      {children}
                      <StatusBar style="auto" />
                      <Toaster
                        position="bottom-center"
                        swipeToDismissDirection="left"
                        offset={15}
                      />
                    </BottomSheetModalProvider>
                  </LiveSpaceProvider>
                </AgoraProvider>
              </OxyServicesSync>
            </OxyProvider>
          </QueryClientProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});
