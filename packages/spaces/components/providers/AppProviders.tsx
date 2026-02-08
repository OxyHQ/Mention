import React, { memo, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider, useAuth } from '@oxyhq/services';
import { OxyServices } from '@oxyhq/core';
import { SpacesProvider, LiveSpaceProvider } from '@mention/spaces-shared';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Toaster } from 'sonner-native';

import { spacesConfig } from '@/lib/spacesConfig';
import { setOxyServicesRef } from '@/utils/api';

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
        <QueryClientProvider client={queryClient}>
          <OxyProvider
            oxyServices={oxyServices}
            storageKeyPrefix="spaces"
          >
            <OxyServicesSync>
              <SpacesProvider config={spacesConfig}>
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
              </SpacesProvider>
            </OxyServicesSync>
          </OxyProvider>
        </QueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});
