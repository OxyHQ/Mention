/**
 * AppProviders Component
 * Centralizes all provider components for better organization
 * Memoized to prevent unnecessary re-renders
 */

import React, { memo, useCallback } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { MenuProvider } from 'react-native-popup-menu';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider } from '@oxyhq/services';
import { OxyServices } from '@oxyhq/core';
import { LiveConfigProvider, LiveRoomProvider } from '@syra.fm/sdk';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { HomeRefreshProvider } from '@/context/HomeRefreshContext';
import { LayoutScrollProvider } from '@/context/LayoutScrollContext';
import { OXY_CLIENT_ID } from '@/config';
import { ToastOutlet } from '@oxyhq/bloom/toast';
import { ConfirmPromptProvider } from '@/components/common/ConfirmPrompt';
import { FediverseInfoDialogProvider } from '@/components/Fediverse/FediverseInfoDialog';
import i18n from '@/lib/i18n';
import { liveConfig } from '@/lib/liveConfig';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('AppProviders');

interface AppProvidersProps {
  children: React.ReactNode;
  oxyServices: OxyServices;
  queryClient: QueryClient;
}

export const AppProviders = memo(function AppProviders({
  children,
  oxyServices,
  queryClient,
}: AppProvidersProps) {
  const handleBoundaryError = useCallback((error: Error, errorInfo: React.ErrorInfo) => {
    logger.error('Error caught by boundary', { error, errorInfo });
  }, []);

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/*
         * react-native-keyboard-controller's root provider. It MUST sit inside
         * GestureHandlerRootView and above everything that consumes
         * KeyboardContext — OxyProvider's sheets and Bloom's BottomSheet — or
         * those hooks log "Couldn't find real values for KeyboardContext" on
         * native. It is a passthrough no-op on web (the library handles the
         * platform split internally; no manual .web fork needed).
         */}
        <KeyboardProvider>
          <OxyProvider
            oxyServices={oxyServices}
            clientId={OXY_CLIENT_ID}
            storageKeyPrefix="mention"
            queryClient={queryClient}
          >
            <I18nextProvider i18n={i18n}>
              <LiveConfigProvider config={liveConfig}>
                <LiveRoomProvider>
                  <BottomSheetProvider>
                    <MenuProvider>
                      <AppErrorBoundary
                        onError={handleBoundaryError}
                      >
                        <LayoutScrollProvider>
                          <HomeRefreshProvider>
                            {children}
                            <StatusBar style="auto" />
                            <ToastOutlet />
                            <ConfirmPromptProvider />
                            <FediverseInfoDialogProvider />
                          </HomeRefreshProvider>
                        </LayoutScrollProvider>
                      </AppErrorBoundary>
                    </MenuProvider>
                  </BottomSheetProvider>
                </LiveRoomProvider>
              </LiveConfigProvider>
            </I18nextProvider>
          </OxyProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});
