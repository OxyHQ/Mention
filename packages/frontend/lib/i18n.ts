/**
 * i18n Configuration and Initialization
 * Separated from _layout.tsx for better testability and maintainability
 */

import i18n, {
  changeLanguage,
  init as i18nInit,
  use as i18nUse,
  type Resource,
  type ResourceKey,
} from 'i18next';
import { initReactI18next } from 'react-i18next';

import enUS from '@/locales/en.json';

import { DEFAULT_LANGUAGE, STORAGE_KEYS } from './constants';
import { Storage } from '@/utils/storage';
import { logger } from '@oxyhq/core/logger';

/**
 * `en-US` is both `DEFAULT_LANGUAGE` and `fallbackLng`, so it is needed on every
 * boot and stays in the initial graph. The other locales are fetched on demand:
 * statically importing all three put every translation of every string into the
 * web app's initial chunk, ~40 KB gzip of which no single user can ever read.
 *
 * Same shape as bluesky-social/social-app 41b374236, which moved its message
 * catalogs (and date-fns locale data, which we do not use) behind `import()`.
 */
const TRANSLATION_LOADERS: Record<string, () => Promise<ResourceKey>> = {
  'es-ES': async () => (await import('@/locales/es.json')).default,
  'it-IT': async () => (await import('@/locales/it.json')).default,
};

const baseResources: Resource = { 'en-US': { translation: enUS } };

/**
 * Resolves a language's translations, or `null` when the language needs none
 * beyond the statically bundled default. A failed fetch is not fatal — i18next
 * falls back to `DEFAULT_LANGUAGE`.
 */
async function loadTranslation(language: string): Promise<ResourceKey | null> {
  const load = TRANSLATION_LOADERS[language];
  if (!load) return null;

  try {
    return await load();
  } catch (error) {
    logger.error('Failed to load translation bundle', error, { language });
    return null;
  }
}

/**
 * Switches language, fetching its translations first so the new strings are
 * present before the re-render. This is the only supported way to change
 * language — calling i18next's `changeLanguage` directly would switch to a
 * language whose bundle has never been loaded.
 */
export async function setLanguage(language: string): Promise<void> {
  if (!i18n.hasResourceBundle(language, 'translation')) {
    const translation = await loadTranslation(language);
    if (translation) {
      i18n.addResourceBundle(language, 'translation', translation);
    }
  }

  await changeLanguage(language);
}

/**
 * Loads the saved language preference from storage
 */
export async function loadSavedLanguage(): Promise<string> {
  try {
    const savedLanguage = await Storage.get<string>(STORAGE_KEYS.LANGUAGE_PREFERENCE);
    return savedLanguage || DEFAULT_LANGUAGE;
  } catch (error) {
    logger.error('Failed to load saved language', error);
    return DEFAULT_LANGUAGE;
  }
}

/**
 * Initializes i18n with the saved language preference
 */
export async function initializeI18n(): Promise<void> {
  try {
    const initialLanguage = await loadSavedLanguage();

    if (i18n.isInitialized) {
      // If already initialized, just change the language
      await setLanguage(initialLanguage);
      return;
    }

    // Resolve the saved language's translations before init so the first render
    // already has them and never flashes the fallback language.
    const translation = await loadTranslation(initialLanguage);
    const resources: Resource = translation
      ? { ...baseResources, [initialLanguage]: { translation } }
      : baseResources;

    // Initialize i18n with the saved language
    i18nUse(initReactI18next);
    await i18nInit({
      resources,
      lng: initialLanguage,
      fallbackLng: DEFAULT_LANGUAGE,
      interpolation: { escapeValue: false },
    });
  } catch (error) {
    logger.error('i18n initialization failed', error);
    // Fallback to default initialization
    if (!i18n.isInitialized) {
      try {
        i18nUse(initReactI18next);
        await i18nInit({
          resources: baseResources,
          lng: DEFAULT_LANGUAGE,
          fallbackLng: DEFAULT_LANGUAGE,
          interpolation: { escapeValue: false },
        });
      } catch (fallbackError) {
        logger.error('i18n fallback initialization failed', fallbackError);
        throw fallbackError;
      }
    }
  }
}

export default i18n;
