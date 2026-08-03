import { describe, expect, it } from 'vitest';
import { MAX_POST_LINK_PREVIEWS } from '@mention/shared-types';
import { extractUrls } from '../../utils/extractUrls';

describe('extractUrls', () => {
  it('returns the URLs in text order', () => {
    expect(extractUrls('Check https://example.com/path and https://other.test')).toEqual([
      'https://example.com/path',
      'https://other.test',
    ]);
  });

  it('normalizes www URLs and strips trailing punctuation', () => {
    expect(extractUrls('See www.example.com/page.')).toEqual(['https://www.example.com/page']);
    expect(extractUrls('Read (https://example.com/a), then https://example.com/b!')).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('returns an empty array when no URL is present', () => {
    expect(extractUrls('plain text only')).toEqual([]);
  });

  it('deduplicates repeated URLs, preserving first-occurrence order', () => {
    expect(
      extractUrls('https://b.test then https://a.test then https://b.test again'),
    ).toEqual(['https://b.test', 'https://a.test']);
  });

  it('caps the result at MAX_POST_LINK_PREVIEWS', () => {
    const text = ['1', '2', '3', '4', '5', '6'].map((n) => `https://example.com/${n}`).join(' ');
    const urls = extractUrls(text);

    expect(MAX_POST_LINK_PREVIEWS).toBe(4);
    expect(urls).toHaveLength(MAX_POST_LINK_PREVIEWS);
    expect(urls).toEqual([
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
      'https://example.com/4',
    ]);
  });

  it('honors an explicit max', () => {
    expect(extractUrls('https://a.test https://b.test https://c.test', 2)).toEqual([
      'https://a.test',
      'https://b.test',
    ]);
    expect(extractUrls('https://a.test', 0)).toEqual([]);
  });
});

describe('extractUrls — shared entity definitions', () => {
  it('keeps a balanced closing paren, which belongs to the URL', () => {
    const url = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    expect(extractUrls(`see ${url}`)).toEqual([url]);
  });

  it('keeps the balanced bracket closing an IPv6 host', () => {
    // Trimming `]` unconditionally yields `http://[::1`, which does not parse —
    // so the URL was silently DROPPED by the `new URL()` guard below.
    expect(extractUrls('see http://[::1] now')).toEqual(['http://[::1]']);
  });

  it('trims an unbalanced closing paren wrapping the link', () => {
    expect(extractUrls('and (https://z.test)')).toEqual(['https://z.test']);
  });

  it('normalizes a host that merely starts with "http"', () => {
    // The old scheme test was `startsWith('http')`, which read this host as
    // already scheme-bearing and emitted an unopenable bare value.
    expect(extractUrls('visit www.httpbin.test')).toEqual(['https://www.httpbin.test']);
  });
});
