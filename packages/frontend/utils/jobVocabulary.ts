import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { JobLocation } from '@clarity.surf/sdk';
import {
  formatMentionJobLocation,
  isCountryCode,
  mentionJobLocationParts,
  type CountryCode,
  type CurrencyCode,
  type MentionJobLocation,
} from '@mention/shared-types';

/**
 * Display names for Clarity's closed job vocabularies (ISO 3166-1 countries,
 * ISO 4217 currencies), localized with `Intl.DisplayNames`.
 *
 * Hermes ships only Collator, DateTimeFormat and NumberFormat (see
 * `utils/postLanguages.ts`), so on a native build there is no `DisplayNames`
 * and every lookup answers `undefined`. Callers always show the CODE, which is
 * exact on every platform, and add the name where one exists — never a guess.
 */

type DisplayNamesType = 'region' | 'currency';

const cache = new Map<string, { of(code: string): string | undefined } | null>();

function displayNames(locale: string | undefined, type: DisplayNamesType) {
  const key = `${type}:${locale ?? ''}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let names: { of(code: string): string | undefined } | null = null;
  const DisplayNames = (Intl as { DisplayNames?: new (locales: string[] | undefined, options: { type: DisplayNamesType; fallback: 'none' }) => { of(code: string): string | undefined } }).DisplayNames;
  if (DisplayNames) {
    try {
      names = new DisplayNames(locale ? [locale] : undefined, { type, fallback: 'none' });
    } catch {
      names = null;
    }
  }
  cache.set(key, names);
  return names;
}

function lookup(locale: string | undefined, type: DisplayNamesType, code: string): string | undefined {
  try {
    const name = displayNames(locale, type)?.of(code);
    return name && name !== code ? name : undefined;
  } catch {
    return undefined;
  }
}

/** `Spain` where the platform can name it, otherwise the code. */
export function countryName(code: CountryCode, locale?: string): string {
  return lookup(locale, 'region', code) ?? code;
}

/** `Euro`, or `undefined` where the platform cannot name it. */
export function currencyName(code: CurrencyCode, locale?: string): string | undefined {
  return lookup(locale, 'currency', code);
}

/** `Barcelona, Catalonia, Spain` for a Mention-authored job. */
export function formatJobLocation(location: MentionJobLocation, locale?: string): string {
  return formatMentionJobLocation(location, (code) => countryName(code, locale));
}

/**
 * A Clarity listing's first location, from its structured fields when Clarity
 * resolved them, falling back to the source's own text for a crawled listing
 * Clarity could not place (that text is what the source published, not ours).
 */
export function formatClarityJobLocation(location: JobLocation | undefined, locale?: string): string | undefined {
  if (!location) return undefined;
  if (location.countryCode && isCountryCode(location.countryCode)) {
    return mentionJobLocationParts(
      { countryCode: location.countryCode, region: location.region, city: location.locality },
      (code) => countryName(code, locale),
    ).join(', ');
  }
  return location.raw || undefined;
}

/** The viewer's locale, bound once per render. */
export function useJobVocabulary() {
  const { i18n } = useTranslation();
  const locale = i18n?.language;
  return useMemo(
    () => ({
      locale,
      countryName: (code: CountryCode) => countryName(code, locale),
      currencyName: (code: CurrencyCode) => currencyName(code, locale),
      formatJobLocation: (location: MentionJobLocation) => formatJobLocation(location, locale),
      formatClarityJobLocation: (location: JobLocation | undefined) => formatClarityJobLocation(location, locale),
    }),
    [locale],
  );
}
