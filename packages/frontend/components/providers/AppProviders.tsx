/**
 * AppProviders Component
 * Centralizes all provider components for better organization
 * Memoized to prevent unnecessary re-renders
 */

import React, { memo, useCallback } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { MenuProvider } from 'react-native-popup-menu';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider } from '@oxyhq/services';
import { OxyServices } from '@oxyhq/core';
import { AgoraProvider, LiveRoomProvider } from '@mention/agora-shared';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { HomeRefreshProvider } from '@/context/HomeRefreshContext';
import { LayoutScrollProvider } from '@/context/LayoutScrollContext';
import { ToastOutlet } from '@oxyhq/bloom/toast';
import { ConfirmPromptProvider } from '@/components/common/ConfirmPrompt';
import i18n from '@/lib/i18n';
import { agoraConfig } from '@/lib/agoraConfig';
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
        <OxyProvider
          oxyServices={oxyServices}
          appName="Mention"
          storageKeyPrefix="mention"
          queryClient={queryClient}
        >
          <I18nextProvider i18n={i18n}>
            <AgoraProvider config={agoraConfig}>
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
                        </HomeRefreshProvider>
                      </LayoutScrollProvider>
                    </AppErrorBoundary>
                  </MenuProvider>
                </BottomSheetProvider>
              </LiveRoomProvider>
            </AgoraProvider>
          </I18nextProvider>
        </OxyProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});
