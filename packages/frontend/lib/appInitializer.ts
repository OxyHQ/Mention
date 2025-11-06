/**
 * App Initialization Service
 * Centralizes all initialization logic for better testability and maintainability
 */

import { Platform } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

import { OxyServices } from '@oxyhq/services';

import { useAppearanceStore } from '@/store/appearanceStore';
import { useVideoMuteStore } from '@/stores/videoMuteStore';
import {
  hasNotificationPermission,
  setupNotifications,
} from '@/utils/notifications';
import { initializeI18n } from './i18n';
import { INITIALIZATION_TIMEOUT } from './constants';

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
  const maybe = services as unknown as {
    waitForAuth?: (ms?: number) => Promise<boolean>;
  };
  if (typeof maybe.waitForAuth === 'function') {
    try {
      return await maybe.waitForAuth(timeoutMs);
    } catch (e) {
      console.warn('waitForAuth failed:', e);
      return false;
    }
  }
  return false;
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
    console.warn('Failed to setup notifications:', error);
  }
}

/**
 * Loads user appearance settings
 */
async function loadAppearanceSettings(): Promise<void> {
  try {
    await useAppearanceStore.getState().loadMySettings();
  } catch (error) {
    console.warn('Failed to load appearance settings:', error);
  }
}

/**
 * Loads video mute state
 */
async function loadVideoMuteState(): Promise<void> {
  try {
    await useVideoMuteStore.getState().loadMutedState();
  } catch (error) {
    console.warn('Failed to load video mute state:', error);
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
    console.warn('Failed to fetch current user during init:', error);
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
      // Setup notifications for native platforms
      await setupNotificationsIfNeeded();

      // Wait for auth to be ready
      const authReady = await waitForAuth(services, INITIALIZATION_TIMEOUT.AUTH);

      // Fetch current user if auth is ready
      await fetchCurrentUser(services, authReady);

      // Load appearance settings (uses cache for instant theme)
      await loadAppearanceSettings();

      // Hide splash screen
      try {
        await SplashScreen.hideAsync();
      } catch (error) {
        console.warn('Failed to hide native splash screen:', error);
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error('Unknown initialization error'),
      };
    }
  }

  /**
   * Loads eager settings that don't block app initialization
   */
  static async loadEagerSettings(): Promise<void> {
    // Load these in parallel as they don't block app startup
    await Promise.allSettled([
      loadAppearanceSettings(),
      loadVideoMuteState(),
    ]);
  }
}

