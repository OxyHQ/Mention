import { WEB_BASE_URL } from '@/config';
import { homeHrefPreservingEntry, preservedEntryQuery, signupPublicUrl } from '../signupEntry';

describe('signup entry query', () => {
  it('keeps utm params, the click id and the guest locale', () => {
    expect(
      preservedEntryQuery({
        utm_source: 'ads',
        utm_medium: 'cpc',
        utm_campaign: 'launch',
        utm_content: 'feed',
        utm_term: 'mention',
        fbclid: 'click',
        lang: 'es',
      }),
    ).toBe(
      '?fbclid=click&lang=es&utm_campaign=launch&utm_content=feed&utm_medium=cpc&utm_source=ads&utm_term=mention',
    );
  });

  it('keeps a single router value and drops unrelated params', () => {
    expect(
      homeHrefPreservingEntry({
        utm_source: ['newsletter'],
        ref: 'friend',
        utm_empty: '',
      }),
    ).toBe('/?utm_source=newsletter');
  });

  it('sends a visit with no campaign query home unchanged', () => {
    expect(homeHrefPreservingEntry({})).toBe('/');
  });

  it('builds the public signup URL from the configured web origin', () => {
    expect(signupPublicUrl()).toBe(`${WEB_BASE_URL.replace(/\/+$/, '')}/signup`);
    expect(signupPublicUrl().endsWith('/signup')).toBe(true);
  });
});
