import { describe, expect, it } from 'vitest';
import { postTextHasHttpLink } from '../../utils/postSearchMetadata';

describe('postTextHasHttpLink', () => {
  it('checks every localized variant without treating arbitrary text as a link', () => {
    expect(
      postTextHasHttpLink([
        { text: 'sin enlace' },
        { text: 'See HTTPS://example.com/docs' },
      ]),
    ).toBe(true);
    expect(postTextHasHttpLink([{ text: 'example.com is plain text' }])).toBe(false);
    expect(postTextHasHttpLink(undefined)).toBe(false);
  });
});
