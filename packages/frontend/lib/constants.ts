/**
 * Application-wide constants
 * Centralized configuration for better maintainability
 */

export const STORAGE_KEYS = {
  LANGUAGE_PREFERENCE: 'user_language_preference',
  THREAD_SORT: 'pref:thread:sortOrder',
  THREAD_TREE_VIEW: 'pref:thread:treeView',
  VOTE_STYLE: 'pref:post:voteStyle',
} as const;

export const DEFAULT_LANGUAGE = 'en-US';

export const SUPPORTED_LANGUAGES = [
  'en-US',
  'es-ES',
  'it-IT',
  'ca-ES',
  'fr-FR',
  'pt-BR',
  'de-DE',
  'ru-RU',
  'zh-CN',
  'hi-IN',
  'ar-SA',
  'bn-BD',
  'ja-JP',
  'id-ID',
  'tr-TR',
] as const;

export const INITIALIZATION_TIMEOUT = {
  AUTH: 1000, // Fast timeout for cached token check
  /** Native only: pause after startup before asking for notification permission. */
  PERMISSION_PROMPT_DELAY: 400,
} as const;
