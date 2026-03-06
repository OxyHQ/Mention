import React, { memo, useEffect, useMemo, useCallback } from 'react';
import { Platform } from 'react-native';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider, useOxy } from '@oxyhq/services';
import { OxyServices } from '@oxyhq/core';
import { AgoraProvider, LiveRoomProvider } from '@mention/agora-shared';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { Toaster } from 'sonner-native';

import { agoraConfig } from '@/lib/agoraConfig';
import { roomQueryKeys } from '@/hooks/useRoomsQuery';
import { setOxyServicesRef, setActiveSessionIdRef } from '@/utils/api';

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
  const { oxyServices, activeSessionId } = useOxy();
  useEffect(() => {
    if (oxyServices) setOxyServicesRef(oxyServices);
  }, [oxyServices]);
  useEffect(() => {
    setActiveSessionIdRef(activeSessionId ?? null);
  }, [activeSessionId]);
  return <>{children}</>;
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
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardProvider>
          <QueryClientProvider client={queryClient}>
            <OxyProvider
              oxyServices={oxyServices}
              storageKeyPrefix="agora"
            >
              <OxyServicesSync>
                <AgoraProviderWithInvalidation>
                  <LiveRoomProvider>
                    <BottomSheetModalProvider>
                      {children}
                      <StatusBar style="auto" />
                      <Toaster
                        position="bottom-center"
                        swipeToDismissDirection="left"
                        offset={15}
                      />
                    </BottomSheetModalProvider>
                  </LiveRoomProvider>
                </AgoraProviderWithInvalidation>
              </OxyServicesSync>
            </OxyProvider>
          </QueryClientProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});
