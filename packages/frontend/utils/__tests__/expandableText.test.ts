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

  it('does not truncate when text overshoots maxChars by less than 10%', () => {
    const text = 'a'.repeat(215);
    expect(computeExpandableText(text, 200, false)).toEqual({
      displayText: text,
      isTruncated: false,
    });
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

  it('counts labels instead of hidden mention destinations', () => {
    const text = 'Hello [@Mention](mention@very-long-instance.example)';
    expect(computeExpandableText(text, 13, false)).toEqual({
      displayText: text,
      isTruncated: false,
    });
  });

  it.each(['allo', 'allo@example.org', 'https://example.org/users/opaque-id'])(
    'clips a label and preserves destination %s',
    (target) => {
      const text = `Mention, [@Allo](${target}) answers too`;
      expect(computeExpandableText(text, 11, false)).toEqual({
        displayText: `Mention, [@Al…](${target})`,
        isTruncated: true,
      });
    },
  );

  it('keeps earlier mentions intact when a later label crosses the limit', () => {
    expect(
      computeExpandableText('[@Mention](mention), [@Allo](allo), [@Oxy](oxy)', 11, false)
        .displayText,
    ).toBe('[@Mention](mention), [@Al…](allo)');
  });

  it('cuts at mention boundaries without exposing markup', () => {
    const text = 'Hi [@Allo](allo) world';
    expect(computeExpandableText(text, 3, false).displayText).toBe('Hi…');
    expect(computeExpandableText(text, 7, false).displayText).toBe('Hi [@Allo](allo)…');
    expect(computeExpandableText(text, 9, false).displayText).toBe('Hi [@Allo](allo) w…');
  });

  it('expands the original mention labels and destinations', () => {
    const text = 'Hi [@Allo](allo) world';
    expect(computeExpandableText(text, 5, true)).toEqual({ displayText: text, isTruncated: true });
  });
});
