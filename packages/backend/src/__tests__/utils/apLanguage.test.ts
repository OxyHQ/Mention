import { describe, it, expect } from 'vitest';
import { extractApLanguage } from '../../utils/federation/apLanguage';

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
