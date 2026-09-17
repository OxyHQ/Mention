import { describe, expect, it } from 'bun:test';
import {
  COUNTRY_CODES as CLARITY_COUNTRY_CODES,
  CURRENCY_CODES as CLARITY_CURRENCY_CODES,
  JOB_SALARY_INTERVALS,
} from '@clarity.surf/sdk/vocabularies';
import {
  COUNTRY_CODES,
  CURRENCY_CODES,
  MENTION_JOB_SALARY_INTERVALS,
  formatMentionJobLocation,
  isCountryCode,
  isCurrencyCode,
  mentionJobLocationParts,
} from '../src/job';

describe('job vocabularies are Clarity’s own', () => {
  it('re-exports the SDK arrays, not a copy that can drift', () => {
    // The SDK's CommonJS and ESM builds are separate module instances, so the
    // arrays are equal rather than identical.
    expect(CURRENCY_CODES).toEqual(CLARITY_CURRENCY_CODES);
    expect(COUNTRY_CODES).toEqual(CLARITY_COUNTRY_CODES);
  });

  it('accepts only exact codes', () => {
    expect(isCurrencyCode('EUR')).toBe(true);
    expect(isCurrencyCode('eur')).toBe(false);
    expect(isCurrencyCode('XAU')).toBe(false);
    expect(isCountryCode('ES')).toBe(true);
    expect(isCountryCode('XK')).toBe(false);
  });

  it('uses the same salary intervals Clarity validates', () => {
    expect([...MENTION_JOB_SALARY_INTERVALS]).toEqual([...JOB_SALARY_INTERVALS]);
  });
});

describe('formatMentionJobLocation', () => {
  it('orders city, region, country and localizes the country through the lookup', () => {
    const location = { placeId: '3128760', countryCode: 'ES', region: 'Catalonia', city: 'Barcelona' } as const;
    expect(formatMentionJobLocation(location)).toBe('Barcelona, Catalonia, ES');
    expect(formatMentionJobLocation(location, () => 'Spain')).toBe('Barcelona, Catalonia, Spain');
  });

  it('shows a region place once and a country-only role as the country alone', () => {
    expect(mentionJobLocationParts({ placeId: '3336901', countryCode: 'ES', region: 'Catalonia', city: 'Catalonia' })).toEqual([
      'Catalonia',
      'ES',
    ]);
    expect(formatMentionJobLocation({ countryCode: 'DE' }, () => 'Germany')).toBe('Germany');
  });
});
