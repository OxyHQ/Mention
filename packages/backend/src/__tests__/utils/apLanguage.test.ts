import { describe, it, expect } from 'vitest';
import { extractApLanguage, extractApLanguages } from '../../connectors/activitypub/apLanguage';

describe('extractApLanguage', () => {
  it('reads a top-level language field', () => {
    expect(extractApLanguage({ language: 'en' })).toBe('en');
  });

  it('normalizes a BCP-47 language to its primary subtag', () => {
    expect(extractApLanguage({ language: 'pt-BR' })).toBe('pt');
    expect(extractApLanguage({ language: 'zh-Hant-TW' })).toBe('zh');
    expect(extractApLanguage({ language: 'ES' })).toBe('es');
  });

  it('falls back to a single-key contentMap', () => {
    expect(extractApLanguage({ contentMap: { es: '<p>hola mundo</p>' } })).toBe('es');
    expect(extractApLanguage({ contentMap: { 'fr-FR': '<p>bonjour</p>' } })).toBe('fr');
  });

  it('prefers the top-level language over contentMap', () => {
    expect(extractApLanguage({ language: 'en', contentMap: { es: '<p>hola</p>' } })).toBe('en');
  });

  it('ignores an ambiguous multi-key contentMap', () => {
    expect(extractApLanguage({ contentMap: { en: '<p>hi</p>', es: '<p>hola</p>' } })).toBeUndefined();
  });

  it('returns undefined for unusable language values', () => {
    expect(extractApLanguage({ language: 'english' })).toBeUndefined();
    expect(extractApLanguage({ language: '' })).toBeUndefined();
    expect(extractApLanguage({ language: 123 })).toBeUndefined();
  });

  it('returns undefined when neither language nor contentMap is present', () => {
    expect(extractApLanguage({ content: '<p>no lang</p>' })).toBeUndefined();
    expect(extractApLanguage({})).toBeUndefined();
  });

  it('handles null / undefined / non-object input safely', () => {
    expect(extractApLanguage(null)).toBeUndefined();
    expect(extractApLanguage(undefined)).toBeUndefined();
  });

  it('ignores a contentMap that is an array', () => {
    expect(extractApLanguage({ contentMap: ['en'] as unknown as Record<string, unknown> })).toBeUndefined();
  });
});

describe('extractApLanguages', () => {
  it('returns all languages from a multi-key contentMap', () => {
    expect(
      extractApLanguages({ contentMap: { en: '<p>hi</p>', es: '<p>hola</p>' } }),
    ).toEqual(['en', 'es']);
  });

  it('includes the top-level language first, then every contentMap key (deduped)', () => {
    expect(
      extractApLanguages({ language: 'en', contentMap: { en: '<p>hi</p>', es: '<p>hola</p>' } }),
    ).toEqual(['en', 'es']);
  });

  it('normalizes every entry to its ISO 639-1 primary subtag', () => {
    expect(
      extractApLanguages({ language: 'pt-BR', contentMap: { 'pt-BR': '<p>oi</p>', 'en-US': '<p>hi</p>' } }),
    ).toEqual(['pt', 'en']);
  });

  it('returns a single-element list for a top-level language only', () => {
    expect(extractApLanguages({ language: 'fr' })).toEqual(['fr']);
  });

  it('returns a single-element list for an unambiguous single-key contentMap', () => {
    expect(extractApLanguages({ contentMap: { es: '<p>hola mundo</p>' } })).toEqual(['es']);
  });

  it('skips unusable codes but keeps the usable ones', () => {
    expect(
      extractApLanguages({ language: 'english', contentMap: { es: '<p>hola</p>', xx9: '<p>?</p>' } }),
    ).toEqual(['es']);
  });

  it('returns [] when neither language nor contentMap yields a usable code', () => {
    expect(extractApLanguages({ content: '<p>no lang</p>' })).toEqual([]);
    expect(extractApLanguages({})).toEqual([]);
    expect(extractApLanguages({ language: 123 })).toEqual([]);
  });

  it('handles null / undefined / array contentMap safely', () => {
    expect(extractApLanguages(null)).toEqual([]);
    expect(extractApLanguages(undefined)).toEqual([]);
    expect(
      extractApLanguages({ contentMap: ['en'] as unknown as Record<string, unknown> }),
    ).toEqual([]);
  });
});
