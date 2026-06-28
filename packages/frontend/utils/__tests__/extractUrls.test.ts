/**
 * Tests run under either jest (frontend `jest-expo` preset) or vitest (workspace
 * runner). Both provide the same describe/it/expect globals.
 */

import { extractUrls, toOpenableUrl, trimUrlTrailingPunct } from '../extractUrls';

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
