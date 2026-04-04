/**
 * App Initialization Service
 * Centralizes all initialization logic for better testability and maintainability
 */

import { Platform } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

import { OxyServices } from '@oxyhq/core';

import { useAppearanceStore } from '@/store/appearanceStore';
import { useVideoMuteStore } from '@/stores/videoMuteStore';
import {
  hasNotificationPermission,
  setupNotifications,
} from '@/utils/notifications';
import { initializeI18n } from './i18n';
import { INITIALIZATION_TIMEOUT } from './constants';
import { logger } from '@/lib/logger';

export interface InitializationResult {
  success: boolean;
  error?: Error;
}

export interface AppInitializationState {
  fontsLoaded: boolean;
  i18nInitialized: boolean;
  notificationsSetup: boolean;
  authReady: boolean;
  appearanceLoaded: boolean;
  videoMuteLoaded: boolean;
}

/**
 * Waits for authentication to be ready
 */
async function waitForAuth(
  services: OxyServices,
  timeoutMs: number = INITIALIZATION_TIMEOUT.AUTH
): Promise<boolean> {
  try {
    return await services.waitForAuth(timeoutMs);
  } catch (e) {
    logger.warn('waitForAuth failed', { error: e });
    return false;
  }
}

/**
 * Sets up notifications for native platforms
 */
async function setupNotificationsIfNeeded(): Promise<void> {
  if (Platform.OS === 'web') {
    return;
  }

  try {
    await setupNotifications();
    await hasNotificationPermission();
  } catch (error) {
    logger.warn('Failed to setup notifications', { error });
  }
}

/**
 * Loads user appearance settings
 */
async function loadAppearanceSettings(services?: OxyServices, isAuthenticated?: boolean): Promise<void> {
  try {
    // Check auth state if services provided
    let authState = isAuthenticated;
    if (services && authState === undefined) {
      try {
        // Quick check if auth is ready (with short timeout)
        authState = await services.waitForAuth(100);
      } catch {
        authState = false;
      }
    }
    await useAppearanceStore.getState().loadMySettings(authState);
  } catch (error) {
    logger.warn('Failed to load appearance settings', { error });
  }
}

/**
 * Loads video mute state
 */
async function loadVideoMuteState(): Promise<void> {
  try {
    await useVideoMuteStore.getState().loadMutedState();
  } catch (error) {
    logger.warn('Failed to load video mute state', { error });
  }
}

/**
 * Fetches current user if auth is ready
 */
async function fetchCurrentUser(services: OxyServices, authReady: boolean): Promise<void> {
  if (!authReady) {
    return;
  }

  try {
    await services.getCurrentUser();
  } catch (error) {
    logger.warn('Failed to fetch current user during init', { error });
  }
}

/**
 * Main app initialization function
 * Coordinates all initialization steps
 */
export class AppInitializer {
  /**
   * Initializes i18n
   */
  static async initializeI18n(): Promise<InitializationResult> {
    try {
      await initializeI18n();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error('Unknown i18n error'),
      };
    }
  }

  /**
   * Initializes the entire app
   */
  static async initializeApp(
    fontsLoaded: boolean,
    services: OxyServices
  ): Promise<InitializationResult> {
    if (!fontsLoaded) {
      return {
        success: false,
        error: new Error('Fonts not loaded'),
      };
    }

    try {
      // Run all init tasks in parallel to minimize startup time
      logger.debug('Starting initialization');
      const authPromise = waitForAuth(services, INITIALIZATION_TIMEOUT.AUTH);

      const results = await Promise.allSettled([
        setupNotificationsIfNeeded().then(() => logger.debug('Notifications done')),
        loadAppearanceSettings(services).then(() => logger.debug('Appearance done')),
        loadVideoMuteState().then(() => logger.debug('VideoMute done')),
        // Fetch current user once auth resolves
        authPromise.then((authReady) => {
          logger.debug('Auth resolved', { authReady });
          return fetchCurrentUser(services, authReady);
        }).then(() => logger.debug('CurrentUser done')),
      ]);

      logger.debug('All tasks settled', { statuses: results.map(r => r.status) });

      // Hide splash screen
      try {
        await SplashScreen.hideAsync();
      } catch (error) {
        logger.warn('Failed to hide native splash screen', { error });
      }

      logger.debug('Initialization complete');
      return { success: true };
    } catch (error) {
      logger.error(error instanceof Error ? error : new Error(String(error)));
      return {
        success: false,
        error: error instanceof Error ? error : new Error('Unknown initialization error'),
      };
    }
  }

}

