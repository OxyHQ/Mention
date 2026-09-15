import { createLogger } from '@oxy.so/core/logger';

const logger = createLogger('AppProviders');

/**
 * `OxyProvider`'s `language` config reports a failed `onChange` here rather
 * than throwing into render — a rejected `setLanguage` (a missing catalog
 * chunk, say) must not take the whole app tree down over a chrome-language
 * mismatch. Its own module, not inline in `AppProviders.tsx`: that file pulls
 * in the whole native provider stack (gesture handler, keyboard controller,
 * reanimated, …), which a test for this one pure function has no business
 * dragging in.
 */
export function handleLanguageError(error: unknown, locale: string): void {
  logger.error('Failed to follow the Oxy-resolved language', error, { locale });
}
