import { computeExpandableText } from '../expandableText';

describe('computeExpandableText', () => {
  it('does not truncate when text is shorter than maxChars', () => {
    const result = computeExpandableText('short text', 200, false);
    expect(result).toEqual({ displayText: 'short text', isTruncated: false });
  });

  it('does not truncate when text is exactly maxChars', () => {
    const text = 'a'.repeat(200);
    const result = computeExpandableText(text, 200, false);
    expect(result).toEqual({ displayText: text, isTruncated: false });
  });

  it('truncates with an ellipsis when text exceeds maxChars and not expanded', () => {
    const text = 'a'.repeat(250);
    const result = computeExpandableText(text, 200, false);
    expect(result.isTruncated).toBe(true);
    expect(result.displayText).toBe(`${'a'.repeat(200)}…`);
  });

  it('trims trailing whitespace before the ellipsis', () => {
    const text = `${'a'.repeat(199)} ${'b'.repeat(50)}`;
    const result = computeExpandableText(text, 200, false);
    expect(result.isTruncated).toBe(true);
    expect(result.displayText.endsWith(' …')).toBe(false);
  });

  it('returns the full text when exceeding maxChars but isExpanded is true', () => {
    const text = 'a'.repeat(250);
    const result = computeExpandableText(text, 200, true);
    expect(result).toEqual({ displayText: text, isTruncated: true });
  });

  it('treats Infinity maxChars as never-truncate', () => {
    const text = 'a'.repeat(10000);
    const result = computeExpandableText(text, Infinity, false);
    expect(result).toEqual({ displayText: text, isTruncated: false });
  });
});
