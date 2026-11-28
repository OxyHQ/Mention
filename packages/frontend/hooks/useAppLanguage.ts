import { useSyncExternalStore } from 'react';

import i18n from '@/lib/i18n';

/**
 * The app's current i18next language, re-rendering on every switch.
 *
 * A subscription to the instance itself rather than `useTranslation()`: the
 * root layout renders before `initializeI18n()` has run, and react-i18next
 * cannot subscribe to an instance that has not been bound yet — it would keep
 * the pre-init value forever. `undefined` until the first language is set,
 * which Bloom reads as "the runtime's locale".
 */
export function useAppLanguage(): string | undefined {
  return useSyncExternalStore(subscribe, readLanguage, readLanguage);
}

function subscribe(onChange: () => void): () => void {
  i18n.on('initialized', onChange);
  i18n.on('languageChanged', onChange);
  return () => {
    i18n.off('initialized', onChange);
    i18n.off('languageChanged', onChange);
  };
}

function readLanguage(): string | undefined {
  return i18n.language || undefined;
}
