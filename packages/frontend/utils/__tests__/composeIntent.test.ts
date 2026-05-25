/**
 * Tests run under either jest (frontend `jest-expo` preset) or vitest
 * (workspace runner). Both provide the same describe/it/expect globals.
 */

// Make __DEV__ a global so `parseComposeIntent`'s dev-only debug log has a
// defined identifier under both Node test runners. Must run before importing
// the module under test.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

// eslint-disable-next-line import/first
import {
  buildComposeText,
  buildQuoteFallbackUrl,
  hasIntentContent,
  MAX_HASHTAGS,
  MAX_MENTIONS,
  MAX_POLL_OPTIONS,
  MAX_POST_LENGTH,
  MAX_SOURCES,
  parseComposeIntent,
  POLL_DURATION_DEFAULT_DAYS,
  validateHttpUrl,
  validateIsoDate,
} from '../composeIntent';

describe('validateHttpUrl', () => {
  it('accepts https URLs', () => {
    expect(validateHttpUrl('https://example.com/path?q=1')).toBe(
      'https://example.com/path?q=1',
    );
  });

  it('accepts http URLs', () => {
    expect(validateHttpUrl('http://example.com')).toBe('http://example.com/');
  });

  it('rejects javascript: URLs', () => {
    expect(validateHttpUrl('javascript:alert(1)')).toBeUndefined();
  });

  it('rejects data: URLs', () => {
    expect(validateHttpUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
  });

  it('rejects file: URLs', () => {
    expect(validateHttpUrl('file:///etc/passwd')).toBeUndefined();
  });

  it('rejects non-URL strings', () => {
    expect(validateHttpUrl('not a url')).toBeUndefined();
  });

  it('rejects empty and whitespace', () => {
    expect(validateHttpUrl('')).toBeUndefined();
    expect(validateHttpUrl('   ')).toBeUndefined();
  });
});

describe('validateIsoDate', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(validateIsoDate('2026-06-15')).toBe('2026-06-15T00:00:00.000Z');
  });

  it('accepts full ISO-8601 with Z', () => {
    expect(validateIsoDate('2026-06-15T12:30:00Z')).toBe('2026-06-15T12:30:00.000Z');
  });

  it('accepts ISO-8601 with offset', () => {
    expect(validateIsoDate('2026-06-15T12:30:00+02:00')).toBe(
      '2026-06-15T10:30:00.000Z',
    );
  });

  it('rejects garbage', () => {
    expect(validateIsoDate('tomorrow')).toBeUndefined();
    expect(validateIsoDate('15/06/2026')).toBeUndefined();
    expect(validateIsoDate('')).toBeUndefined();
  });

  it('rejects impossible dates', () => {
    expect(validateIsoDate('2026-13-40')).toBeUndefined();
  });
});

describe('parseComposeIntent — text', () => {
  it('trims and accepts plain text', () => {
    expect(parseComposeIntent({ text: '  hello world  ' })).toEqual({
      text: 'hello world',
    });
  });

  it('strips HTML from text', () => {
    expect(parseComposeIntent({ text: '<script>alert(1)</script>hi' })).toEqual({
      text: 'alert(1)hi',
    });
  });

  it('drops empty text', () => {
    expect(parseComposeIntent({ text: '   ' })).toEqual({});
  });

  it('takes first when text is an array', () => {
    expect(parseComposeIntent({ text: ['first', 'second'] })).toEqual({
      text: 'first',
    });
  });
});

describe('parseComposeIntent — url', () => {
  it('keeps valid https URL', () => {
    expect(parseComposeIntent({ url: 'https://example.com' })).toEqual({
      url: 'https://example.com/',
    });
  });

  it('drops javascript: URLs', () => {
    expect(parseComposeIntent({ url: 'javascript:alert(1)' })).toEqual({});
  });

  it('drops malformed URLs', () => {
    expect(parseComposeIntent({ url: 'not a url' })).toEqual({});
  });
});

describe('parseComposeIntent — hashtags', () => {
  it('lowercases, dedupes, splits on commas', () => {
    expect(
      parseComposeIntent({ hashtags: 'Tech, NEWS, tech, foo' }),
    ).toEqual({ hashtags: ['tech', 'news', 'foo'] });
  });

  it('strips leading #', () => {
    expect(parseComposeIntent({ hashtags: '#hello,#world' })).toEqual({
      hashtags: ['hello', 'world'],
    });
  });

  it('clamps to MAX_HASHTAGS', () => {
    const tags = Array.from({ length: 25 }, (_, i) => `tag${i}`).join(',');
    const result = parseComposeIntent({ hashtags: tags });
    expect(result.hashtags?.length).toBe(MAX_HASHTAGS);
  });

  it('drops empty / invalid entries', () => {
    expect(
      parseComposeIntent({ hashtags: ', , 🤖, hello, ' }),
    ).toEqual({ hashtags: ['hello'] });
  });
});

describe('parseComposeIntent — via and mentions', () => {
  it('strips leading @ from via', () => {
    expect(parseComposeIntent({ via: '@alice' })).toEqual({ via: 'alice' });
  });

  it('parses comma-separated mentions', () => {
    expect(
      parseComposeIntent({ mentions: '@alice, bob, @carol' }),
    ).toEqual({ mentions: ['alice', 'bob', 'carol'] });
  });

  it('clamps mentions to MAX_MENTIONS', () => {
    const handles = Array.from({ length: 30 }, (_, i) => `user${i}`).join(',');
    const result = parseComposeIntent({ mentions: handles });
    expect(result.mentions?.length).toBe(MAX_MENTIONS);
  });

  it('drops invalid handle chars', () => {
    expect(parseComposeIntent({ via: '!!!' })).toEqual({});
  });
});

describe('parseComposeIntent — poll', () => {
  it('parses pipe-separated options', () => {
    expect(
      parseComposeIntent({ pollOptions: 'Yes|No|Maybe' }),
    ).toEqual({
      poll: { options: ['Yes', 'No', 'Maybe'], durationDays: POLL_DURATION_DEFAULT_DAYS },
    });
  });

  it('drops poll when < 2 options', () => {
    expect(parseComposeIntent({ pollOptions: 'Only' })).toEqual({});
  });

  it('clamps to MAX_POLL_OPTIONS', () => {
    const options = ['a', 'b', 'c', 'd', 'e', 'f'].join('|');
    const result = parseComposeIntent({ pollOptions: options });
    expect(result.poll?.options.length).toBe(MAX_POLL_OPTIONS);
  });

  it('uses custom duration when valid', () => {
    expect(
      parseComposeIntent({ pollOptions: 'a|b', pollDurationDays: '3' }),
    ).toEqual({
      poll: { options: ['a', 'b'], durationDays: 3 },
    });
  });

  it('ignores out-of-range duration', () => {
    expect(
      parseComposeIntent({ pollOptions: 'a|b', pollDurationDays: '99' }),
    ).toEqual({
      poll: { options: ['a', 'b'], durationDays: POLL_DURATION_DEFAULT_DAYS },
    });
  });

  it('trims pipe-split entries and drops empties', () => {
    expect(
      parseComposeIntent({ pollOptions: ' Yes | | No | ' }),
    ).toEqual({
      poll: { options: ['Yes', 'No'], durationDays: POLL_DURATION_DEFAULT_DAYS },
    });
  });
});

describe('parseComposeIntent — article', () => {
  it('parses title and body', () => {
    expect(
      parseComposeIntent({ articleTitle: 'Hello', articleBody: 'World' }),
    ).toEqual({ article: { title: 'Hello', body: 'World' } });
  });

  it('parses partial article (title only)', () => {
    expect(parseComposeIntent({ articleTitle: 'Hi' })).toEqual({
      article: { title: 'Hi' },
    });
  });
});

describe('parseComposeIntent — event', () => {
  it('parses all event fields', () => {
    expect(
      parseComposeIntent({
        eventName: 'Meetup',
        eventDate: '2026-06-15',
        eventLocation: 'Barcelona',
        eventDescription: 'Come join',
      }),
    ).toEqual({
      event: {
        name: 'Meetup',
        date: '2026-06-15T00:00:00.000Z',
        location: 'Barcelona',
        description: 'Come join',
      },
    });
  });

  it('drops invalid date but keeps name', () => {
    expect(
      parseComposeIntent({ eventName: 'Meetup', eventDate: 'tomorrow' }),
    ).toEqual({ event: { name: 'Meetup' } });
  });
});

describe('parseComposeIntent — location', () => {
  it('accepts valid coords', () => {
    expect(
      parseComposeIntent({ lat: '41.38', lng: '2.18', address: 'Barcelona' }),
    ).toEqual({
      location: { latitude: 41.38, longitude: 2.18, address: 'Barcelona' },
    });
  });

  it('drops location when only lat present', () => {
    expect(parseComposeIntent({ lat: '41.38' })).toEqual({});
  });

  it('drops out-of-range coords', () => {
    expect(parseComposeIntent({ lat: '99', lng: '2' })).toEqual({});
    expect(parseComposeIntent({ lat: '41', lng: '200' })).toEqual({});
  });
});

describe('parseComposeIntent — sources', () => {
  it('parses comma-separated http(s) URLs', () => {
    expect(
      parseComposeIntent({ sources: 'https://a.com, https://b.com' }),
    ).toEqual({ sources: ['https://a.com/', 'https://b.com/'] });
  });

  it('drops invalid URLs but keeps valid ones', () => {
    expect(
      parseComposeIntent({ sources: 'https://a.com, javascript:x, https://b.com' }),
    ).toEqual({ sources: ['https://a.com/', 'https://b.com/'] });
  });

  it('clamps to MAX_SOURCES', () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://a${i}.com`).join(',');
    const result = parseComposeIntent({ sources: urls });
    expect(result.sources?.length).toBe(MAX_SOURCES);
  });
});

describe('parseComposeIntent — scheduledFor', () => {
  it('accepts future ISO-8601 date', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const result = parseComposeIntent({ scheduledFor: future });
    expect(result.scheduledFor).toBe(future);
  });

  it('drops past dates', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(parseComposeIntent({ scheduledFor: past })).toEqual({});
  });

  it('drops invalid dates', () => {
    expect(parseComposeIntent({ scheduledFor: 'soon' })).toEqual({});
  });
});

describe('parseComposeIntent — booleans', () => {
  it('accepts 1 / true / yes / on as truthy', () => {
    for (const v of ['1', 'true', 'YES', 'on']) {
      expect(parseComposeIntent({ sensitive: v }).sensitive).toBe(true);
    }
  });

  it('accepts 0 / false / no / off as falsy', () => {
    for (const v of ['0', 'false', 'NO', 'off']) {
      expect(parseComposeIntent({ sensitive: v }).sensitive).toBe(false);
    }
  });

  it('drops sensitive when missing', () => {
    expect(parseComposeIntent({}).sensitive).toBeUndefined();
  });

  it('parses quotesDisabled', () => {
    expect(parseComposeIntent({ quotesDisabled: 'true' }).quotesDisabled).toBe(true);
  });
});

describe('parseComposeIntent — replyPermission', () => {
  it('accepts anyone', () => {
    expect(parseComposeIntent({ replyPermission: 'anyone' })).toEqual({
      replyPermission: 'anyone',
    });
  });

  it('accepts following (case-insensitive)', () => {
    expect(parseComposeIntent({ replyPermission: 'Following' })).toEqual({
      replyPermission: 'following',
    });
  });

  it('rejects unsupported permissions', () => {
    expect(parseComposeIntent({ replyPermission: 'nobody' })).toEqual({});
  });
});

describe('parseComposeIntent — lang', () => {
  it('accepts BCP-47 tags', () => {
    expect(parseComposeIntent({ lang: 'en' })).toEqual({ lang: 'en' });
    expect(parseComposeIntent({ lang: 'es-MX' })).toEqual({ lang: 'es-MX' });
  });

  it('rejects malformed tags', () => {
    expect(parseComposeIntent({ lang: 'english' })).toEqual({});
    expect(parseComposeIntent({ lang: '1234' })).toEqual({});
  });
});

describe('parseComposeIntent — alias and unknown keys', () => {
  it('keeps post id pass-through fields', () => {
    expect(
      parseComposeIntent({
        replyToPostId: 'abc',
        quotePostId: 'def',
        editPostId: 'ghi',
      }),
    ).toEqual({
      replyToPostId: 'abc',
      quotePostId: 'def',
      editPostId: 'ghi',
    });
  });

  it('drops unknown keys silently', () => {
    expect(
      parseComposeIntent({
        text: 'hi',
        unknownKey: 'foo',
        anotherUnknown: 'bar',
      } as Record<string, string>),
    ).toEqual({ text: 'hi' });
  });

  it('handles fully-loaded intent', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const result = parseComposeIntent({
      text: 'Hi',
      url: 'https://example.com',
      hashtags: 'a,b',
      via: '@alice',
      mentions: 'bob,carol',
      replyPermission: 'following',
      pollOptions: 'Yes|No',
      sources: 'https://x.com',
      scheduledFor: future,
      sensitive: '1',
      quotesDisabled: 'true',
      lang: 'en',
    });
    expect(result.text).toBe('Hi');
    expect(result.url).toBe('https://example.com/');
    expect(result.hashtags).toEqual(['a', 'b']);
    expect(result.via).toBe('alice');
    expect(result.mentions).toEqual(['bob', 'carol']);
    expect(result.replyPermission).toBe('following');
    expect(result.poll?.options).toEqual(['Yes', 'No']);
    expect(result.sources).toEqual(['https://x.com/']);
    expect(result.scheduledFor).toBe(future);
    expect(result.sensitive).toBe(true);
    expect(result.quotesDisabled).toBe(true);
    expect(result.lang).toBe('en');
  });
});

describe('buildComposeText', () => {
  it('joins text, url, hashtags, via with spaces', () => {
    const intent = parseComposeIntent({
      text: 'Hello',
      url: 'https://example.com',
      hashtags: 'foo,bar',
      via: 'mention',
    });
    expect(buildComposeText(intent)).toBe(
      'Hello https://example.com/ #foo #bar via @mention',
    );
  });

  it('prepends mentions before text', () => {
    const intent = parseComposeIntent({
      text: 'check this',
      mentions: 'alice,bob',
    });
    expect(buildComposeText(intent)).toBe('@alice @bob check this');
  });

  it('returns empty string for empty intent', () => {
    expect(buildComposeText({})).toBe('');
  });

  it('omits missing pieces', () => {
    expect(buildComposeText({ text: 'Only' })).toBe('Only');
    expect(buildComposeText({ url: 'https://x.com/' })).toBe('https://x.com/');
  });

  it('clamps to MAX_POST_LENGTH with ellipsis', () => {
    const text = 'word '.repeat(200).trim();
    const result = buildComposeText({ text });
    expect(result.length).toBeLessThanOrEqual(MAX_POST_LENGTH);
    expect(result.endsWith('…')).toBe(true);
  });

  it('preserves short text exactly', () => {
    const intent = { text: 'short' };
    expect(buildComposeText(intent)).toBe('short');
  });
});

describe('hasIntentContent', () => {
  it('returns false for empty intent', () => {
    expect(hasIntentContent({})).toBe(false);
  });

  it('returns true for text-only intent', () => {
    expect(hasIntentContent({ text: 'hi' })).toBe(true);
  });

  it('returns true for sensitive false', () => {
    expect(hasIntentContent({ sensitive: false })).toBe(true);
  });

  it('returns true for quotesDisabled false', () => {
    expect(hasIntentContent({ quotesDisabled: false })).toBe(true);
  });
});

describe('buildQuoteFallbackUrl', () => {
  it('builds canonical post URL', () => {
    expect(buildQuoteFallbackUrl('abc123')).toBe('https://mention.earth/p/abc123');
  });
});
