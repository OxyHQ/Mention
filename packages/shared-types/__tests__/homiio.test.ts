import { describe, expect, it } from 'bun:test';
import { homiioCaseFromText, sanitizeHomiioCase } from '../src/homiio';

describe('Homiio references', () => {
  it('keeps only a validated opaque ID', () => {
    expect(
      sanitizeHomiioCase({ caseId: 'opaque/a', title: 'Not ours', address: 'private' }),
    ).toEqual({ caseId: 'opaque/a' });
    for (const value of [null, {}, { caseId: '' }, { caseId: 1 }, { caseId: 'x'.repeat(201) }])
      expect(sanitizeHomiioCase(value)).toBeUndefined();
  });
  it('extracts a reference from a pasted canonical URL with punctuation', () => {
    expect(homiioCaseFromText('Help here (https://homiio.com/evictions/opaque%2Fa).')).toEqual({
      caseId: 'opaque/a',
    });
    for (const text of [
      'https://evil.test/evictions/a',
      'https://homiio.com.evil.test/evictions/a',
      'http://homiio.com/evictions/a',
      'https://user@homiio.com/evictions/a',
    ])
      expect(homiioCaseFromText(text)).toBeUndefined();
  });
});
