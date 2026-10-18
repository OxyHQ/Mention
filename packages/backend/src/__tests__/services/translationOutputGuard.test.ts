import { describe, expect, it } from 'bun:test';
import {
  finalizeTranslation,
  protectEntities,
  TranslationOutputError,
} from '../../services/translationOutputGuard';

describe('translation output guard', () => {
  it('strips one echoed <text> wrapper and rejects an empty answer', () => {
    const source = protectEntities('hello');

    expect(finalizeTranslation('<text>\nhola\n</text>', source)).toBe('hola');
    expect(() => finalizeTranslation('<text>\n</text>', source)).toThrow(TranslationOutputError);
  });

  it('round-trips every protected entity verbatim', () => {
    const original = 'hi [mention:u1] @a@b.example #tag $ABC https://x.example/p.';
    const source = protectEntities(original);

    expect(source.text).toBe('hi ⟦0⟧ ⟦1⟧ ⟦2⟧ ⟦3⟧ ⟦4⟧.');
    expect(finalizeTranslation('hola ⟦0⟧ ⟦1⟧ ⟦2⟧ ⟦3⟧ ⟦4⟧.', source)).toBe(
      original.replace('hi', 'hola'),
    );
  });

  it('rejects an answer that drops or duplicates a token', () => {
    const source = protectEntities('see #tag and @someone');

    expect(() => finalizeTranslation('mira ⟦0⟧ y', source)).toThrow(TranslationOutputError);
    expect(() => finalizeTranslation('mira ⟦0⟧ y ⟦0⟧', source)).toThrow(TranslationOutputError);
  });
});
