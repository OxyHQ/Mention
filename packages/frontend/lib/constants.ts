/**
 * Application-wide constants
 * Centralized configuration for better maintainability
 */

export const STORAGE_KEYS = {
  LANGUAGE_PREFERENCE: 'user_language_preference',
} as const;

export const DEFAULT_LANGUAGE = 'en-US';

export const SUPPORTED_LANGUAGES = ['en-US', 'es-ES', 'it-IT'] as const;

export const INITIALIZATION_TIMEOUT = {
  AUTH: 2000, // Reduced from 5000ms to 2000ms for faster startup
  SPLASH_FADE_DELAY: 400,
} as const;

/**
 * Z-Index layering constants
 * Ensures consistent stacking order across the application
 */
export const Z_INDEX = {
  PORTAL_OUTLET: 9999,
  MODAL: 10000,
  FLOATING_ACTION_BUTTON: 10000,
} as const;

