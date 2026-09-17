import { countryName, currencyName, formatClarityJobLocation, formatJobLocation } from '@/utils/jobVocabulary';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const hasDisplayNames = typeof (Intl as { DisplayNames?: unknown }).DisplayNames === 'function';

describe('jobVocabulary', () => {
  it('names a country and a currency where Intl.DisplayNames exists, and falls back to the code', () => {
    if (hasDisplayNames) {
      expect(countryName('ES', 'en')).toBe('Spain');
      expect(countryName('ES', 'es')).toBe('España');
      expect(currencyName('EUR', 'en')).toBe('Euro');
    } else {
      expect(countryName('ES', 'en')).toBe('ES');
      expect(currencyName('EUR', 'en')).toBeUndefined();
    }
  });

  it('degrades to the code, never to a guess, when the runtime has no DisplayNames (Hermes)', () => {
    const original = (Intl as { DisplayNames?: unknown }).DisplayNames;
    try {
      (Intl as { DisplayNames?: unknown }).DisplayNames = undefined;
      // A locale not looked up before, so the per-locale cache cannot answer.
      expect(countryName('FR', 'x-hermes')).toBe('FR');
      expect(currencyName('JPY', 'x-hermes')).toBeUndefined();
    } finally {
      (Intl as { DisplayNames?: unknown }).DisplayNames = original;
    }
  });

  it('formats a Mention location most-specific first', () => {
    const label = formatJobLocation({ placeId: '3128760', countryCode: 'ES', region: 'Catalonia', city: 'Barcelona' }, 'en');
    expect(label).toBe(hasDisplayNames ? 'Barcelona, Catalonia, Spain' : 'Barcelona, Catalonia, ES');
    expect(formatJobLocation({ countryCode: 'ES' }, 'en')).toBe(hasDisplayNames ? 'Spain' : 'ES');
  });

  it('prefers a Clarity listing’s structured fields and keeps a crawled listing’s own text otherwise', () => {
    expect(formatClarityJobLocation({ raw: 'Anywhere in Spain', countryCode: 'ES' }, 'en')).toBe(hasDisplayNames ? 'Spain' : 'ES');
    expect(formatClarityJobLocation({ raw: 'Planet Earth' }, 'en')).toBe('Planet Earth');
    expect(formatClarityJobLocation(undefined, 'en')).toBeUndefined();
  });
});
