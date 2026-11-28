import { isLinkField, isPronounField } from '../../../utils/federation/profileFieldLinks';

describe('isLinkField', () => {
  it('is true for a value that is a URL, or an anchor to one', () => {
    expect(isLinkField('https://youtube.com/@x')).toBe(true);
    expect(isLinkField('<a href="https://example.com" rel="me">example.com</a>')).toBe(true);
  });

  it('is false for text, and for a link that is not https', () => {
    expect(isLinkField('they/them')).toBe(false);
    expect(isLinkField('http://example.com')).toBe(false);
    expect(isLinkField('<a href="javascript:alert(1)">x</a>')).toBe(false);
  });
});

describe('isPronounField', () => {
  it('names the pronoun field, whatever its case or colon', () => {
    expect(isPronounField('Pronouns')).toBe(true);
    expect(isPronounField('pronouns:')).toBe(true);
    expect(isPronounField('Website')).toBe(false);
  });
});
