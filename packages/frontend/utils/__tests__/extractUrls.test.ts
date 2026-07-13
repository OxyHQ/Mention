/**
 * Tests run under either jest (frontend `jest-expo` preset) or vitest (workspace
 * runner). Both provide the same describe/it/expect globals.
 */

import { extractUrls, removeUrlFromText, toOpenableUrl, trimUrlTrailingPunct } from '../extractUrls';

describe('extractUrls', () => {
  it('extracts a plain https URL', () => {
    expect(extractUrls('Check https://example.com/path here')).toEqual([
      'https://example.com/path',
    ]);
  });

  it('normalizes a bare www. form to an openable https URL', () => {
    expect(extractUrls('visit www.example.com today')).toEqual([
      'https://www.example.com',
    ]);
  });

  it('strips trailing punctuation', () => {
    expect(extractUrls('see https://x.com.')).toEqual(['https://x.com']);
    expect(extractUrls('also www.y.com!')).toEqual(['https://www.y.com']);
    expect(extractUrls('and (https://z.com)')).toEqual(['https://z.com']);
  });

  it('extracts multiple URLs in order', () => {
    expect(extractUrls('a https://a.com and www.b.com!')).toEqual([
      'https://a.com',
      'https://www.b.com',
    ]);
  });

  it('returns an empty array when there are no URLs', () => {
    expect(extractUrls('just plain text, nothing here')).toEqual([]);
  });

  it('returns an empty array for empty input', () => {
    expect(extractUrls('')).toEqual([]);
  });

  it('ignores #hashtags, @mentions, and $cashtags', () => {
    expect(extractUrls('#tag @user $AAPL hello world')).toEqual([]);
  });

  it('deduplicates a URL repeated in the text', () => {
    expect(extractUrls('https://a.com then https://a.com again')).toEqual(['https://a.com']);
  });

  it('deduplicates across the bare and scheme-ful forms of one URL', () => {
    expect(extractUrls('www.a.com and https://www.a.com')).toEqual(['https://www.a.com']);
  });
});

describe('removeUrlFromText', () => {
  it('removes only the target URL and leaves the others', () => {
    expect(removeUrlFromText('Check https://a.com and https://b.com out', 'https://a.com')).toBe(
      'Check and https://b.com out',
    );
    expect(removeUrlFromText('Check https://a.com and https://b.com out', 'https://b.com')).toBe(
      'Check https://a.com and out',
    );
  });

  it('matches a bare www. occurrence against its openable form', () => {
    expect(removeUrlFromText('Visit www.a.com now', 'https://www.a.com')).toBe('Visit now');
  });

  it('keeps punctuation that merely trailed the URL', () => {
    expect(removeUrlFromText('End of sentence https://a.com. Next!', 'https://a.com')).toBe(
      'End of sentence. Next!',
    );
  });

  it('preserves line breaks', () => {
    expect(removeUrlFromText('Line1 https://a.com\nLine2 https://b.com', 'https://a.com')).toBe(
      'Line1\nLine2 https://b.com',
    );
  });

  it('removes every occurrence of the same URL', () => {
    expect(removeUrlFromText('a https://a.com b https://a.com c', 'https://a.com')).toBe('a b c');
  });

  it('leaves the text untouched when the URL is absent', () => {
    expect(removeUrlFromText('no links here', 'https://a.com')).toBe('no links here');
  });
});

describe('trimUrlTrailingPunct', () => {
  it('splits the URL from its trailing punctuation', () => {
    expect(trimUrlTrailingPunct('https://x.com).')).toEqual({
      url: 'https://x.com',
      trailing: ').',
    });
  });

  it('returns the URL unchanged when there is no trailing punctuation', () => {
    expect(trimUrlTrailingPunct('https://x.com/path')).toEqual({
      url: 'https://x.com/path',
      trailing: '',
    });
  });
});

describe('toOpenableUrl', () => {
  it('keeps http(s) URLs as-is', () => {
    expect(toOpenableUrl('https://x.com')).toBe('https://x.com');
    expect(toOpenableUrl('http://x.com')).toBe('http://x.com');
  });

  it('prefixes scheme-less URLs with https://', () => {
    expect(toOpenableUrl('www.x.com')).toBe('https://www.x.com');
  });
});
