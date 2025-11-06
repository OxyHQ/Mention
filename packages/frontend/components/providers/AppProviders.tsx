/**
 * AppProviders Component
 * Centralizes all provider components for better organization
 * Memoized to prevent unnecessary re-renders
 */

import React, { memo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { MenuProvider } from 'react-native-popup-menu';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider, OxyServices } from '@oxyhq/services';

import ErrorBoundary from '@/components/ErrorBoundary';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { HomeRefreshProvider } from '@/context/HomeRefreshContext';
import { LayoutScrollProvider } from '@/context/LayoutScrollContext';
import { Toaster } from '@/lib/sonner';
import i18n from '@/lib/i18n';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';

interface AppProvidersProps {
  children: React.ReactNode;
  oxyServices: OxyServices;
  colorScheme: 'light' | 'dark' | null | undefined;
  queryClient: QueryClient;
}

/**
 * Wraps the app with all necessary providers
 * Separated from _layout.tsx for better testability
 * Memoized to prevent re-renders when props don't change
 */
export const AppProviders = memo(function AppProviders({
  children,
  oxyServices,
  colorScheme,
  queryClient,
}: AppProvidersProps) {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <QueryClientProvider client={queryClient}>
          <OxyProvider
            oxyServices={oxyServices}
            initialScreen="SignIn"
            autoPresent={false}
            storageKeyPrefix="oxy_example"
            theme={colorScheme ?? undefined}
          >
            <I18nextProvider i18n={i18n}>
              <BottomSheetProvider>
                <MenuProvider>
                  <ErrorBoundary>
                    <LayoutScrollProvider>
                      <HomeRefreshProvider>
                        {children}
                        <StatusBar style="auto" />
                        <Toaster
                          position="bottom-center"
                          swipeToDismissDirection="left"
                          offset={15}
                        />
                      </HomeRefreshProvider>
                    </LayoutScrollProvider>
                  </ErrorBoundary>
                </MenuProvider>
              </BottomSheetProvider>
            </I18nextProvider>
          </OxyProvider>
        </QueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});

