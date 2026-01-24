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
  try {
    return await services.waitForAuth(timeoutMs);
  } catch (e) {
    console.warn('waitForAuth failed:', e);
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
    console.warn('Failed to setup notifications:', error);
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
      // Run notifications setup and auth wait in parallel (both can happen simultaneously)
      const [, authReady] = await Promise.all([
        setupNotificationsIfNeeded(),
        waitForAuth(services, INITIALIZATION_TIMEOUT.AUTH),
      ]);

      // After auth is ready, run user fetch and settings loading in parallel
      await Promise.allSettled([
        fetchCurrentUser(services, authReady),
        loadAppearanceSettings(services, authReady),
        loadVideoMuteState(),
      ]);

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
   * Should be called after auth is ready to avoid 401 errors
   */
  static async loadEagerSettings(services?: OxyServices): Promise<void> {
    // Check auth state before loading settings
    let isAuthenticated = false;
    if (services) {
      try {
        // Quick check if auth is ready (with short timeout)
        isAuthenticated = await services.waitForAuth(100);
      } catch {
        // Auth not ready, will skip authenticated API calls
        isAuthenticated = false;
      }
    }

    // Load these in parallel as they don't block app startup
    await Promise.allSettled([
      loadAppearanceSettings(services, isAuthenticated),
      loadVideoMuteState(),
    ]);
  }
}

