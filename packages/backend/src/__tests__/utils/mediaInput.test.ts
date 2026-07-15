import { describe, expect, it } from 'vitest';
import { config } from '../../config';
import { normalizeAltInput, normalizeMediaItems } from '../../utils/mediaInput';

/**
 * The WRITE boundary for client-supplied media.
 *
 * The alt text a Mention client sends is persisted on the post AND signed onto the
 * author's MTN hash chain, where it is immutable. Normalizing it on the way OUT
 * (`PostHydrationService`) makes the feed look right while a raw value is signed
 * forever, so the invariant has to hold HERE — these tests are what pins it down.
 *
 * The rule itself is `normalizeAlt` (`services/MediaMetadataService.ts`), the same
 * one the ActivityPub and atproto ingests apply; this boundary adds the product
 * length cap on top.
 */

describe('normalizeAltInput', () => {
  it('collapses the whitespace INSIDE the value, not just at its ends', () => {
    // The bug a bare `.trim()` cannot see: an embedded newline survives it, and
    // clients render text with `white-space: pre-wrap`.
    expect(normalizeAltInput('un gato\n\n   en una caja')).toBe('un gato en una caja');
    expect(normalizeAltInput('  un gato  ')).toBe('un gato');
  });

  it('drops an empty / whitespace-only / non-string value so the field stays ABSENT', () => {
    expect(normalizeAltInput('   \n  ')).toBeUndefined();
    expect(normalizeAltInput('')).toBeUndefined();
    expect(normalizeAltInput(undefined)).toBeUndefined();
    expect(normalizeAltInput(42)).toBeUndefined();
  });

  it('caps the length and leaves no dangling whitespace at the cut', () => {
    const cap = config.posts.maxAltTextLength;
    const alt = normalizeAltInput(`${'a'.repeat(cap - 1)} bcd`);

    expect(alt).toBeDefined();
    expect(alt?.length).toBeLessThanOrEqual(cap);
    // The cut falls right after the space, which must not survive as a trailing one.
    expect(alt).toBe('a'.repeat(cap - 1));
  });

  it('is idempotent — a value that already went through it is untouched', () => {
    const once = normalizeAltInput(' un   gato\nen una caja ');
    expect(normalizeAltInput(once)).toBe(once);
  });
});

describe('normalizeMediaItems', () => {
  it('normalizes the alt of every accepted item', () => {
    expect(normalizeMediaItems([
      { id: 'a', type: 'image', alt: '  un gato\n  en una caja ' },
      { id: 'b', type: 'video', alt: 'ya limpio' },
    ])).toEqual([
      { id: 'a', type: 'image', alt: 'un gato en una caja' },
      { id: 'b', type: 'video', alt: 'ya limpio' },
    ]);
  });

  it('omits an alt that normalizes to nothing rather than storing an empty string', () => {
    // `alt` is read as "present ⇒ describe the image", so a blank one is a lie the
    // screen reader would have to announce.
    expect(normalizeMediaItems([{ id: 'a', type: 'image', alt: ' \n ' }])).toEqual([
      { id: 'a', type: 'image' },
    ]);
  });

  it('still whitelists the fields it accepts — client metadata is never trusted', () => {
    expect(normalizeMediaItems([
      { id: 'a', type: 'image', alt: ' hola ', width: 9999, cachedFromFederation: true },
    ])).toEqual([{ id: 'a', type: 'image', alt: 'hola' }]);
  });
});
