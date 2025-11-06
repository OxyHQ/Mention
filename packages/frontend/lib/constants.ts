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
  AUTH: 5000,
  SPLASH_FADE_DELAY: 400,
} as const;

