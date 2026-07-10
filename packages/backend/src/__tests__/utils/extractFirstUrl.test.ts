import { describe, expect, it } from 'vitest';
import { extractFirstUrl } from '../../utils/extractFirstUrl';

describe('extractFirstUrl', () => {
  it('returns the first https URL', () => {
    expect(extractFirstUrl('Check https://example.com/path and https://other.test')).toBe(
      'https://example.com/path',
    );
  });

  it('normalizes www URLs', () => {
    expect(extractFirstUrl('See www.example.com/page.')).toBe('https://www.example.com/page');
  });

  it('returns null when no URL is present', () => {
    expect(extractFirstUrl('plain text only')).toBeNull();
  });
});
