import { describe, it, expect } from 'vitest';
import type { PostContentVariant, StoredPostContent } from '@mention/shared-types';
import {
  applyDetectedPrimaryTag,
  authorVariants,
  buildPrimaryVariant,
  declaredBaseLanguages,
  getPrimaryVariant,
  readerVariants,
  resolveVariant,
  resolveViewerTag,
  validateAuthorVariants,
} from '../services/postVariants';

/**
 * Multilingual post content.
 *
 * STORAGE IS NORMALIZED: `variants[]` is the only home for the body and
 * `variants[0]` is the primary. Media and the article stay shared at the top,
 * because that is what they usually are.
 *
 * THE RULE: a variant inherits everything it does not override — no `media` means
 * it shows the post's shared images (its `alt` map localizing THEIR descriptions),
 * `media` present replaces the set outright, and the two together are rejected at
 * the write boundary (two sources of truth for one alt text).
 *
 * THE LADDER: explicit tag → Accept-Language → the viewer's Oxy account locales →
 * the post's primary; within each rung, exact tag → any variant sharing the base
 * subtag. An author variant always beats a machine one for the same language.
 */

const variant = (partial: Partial<PostContentVariant> & Pick<PostContentVariant, 'tag'>): PostContentVariant => ({
  source: 'author',
  text: `body-${partial.tag}`,
  ...partial,
});

/** A Spanish-primary post; extra renditions/media are supplied per test. */
const content = (partial: Partial<StoredPostContent> = {}): StoredPostContent => ({
  variants: [variant({ tag: 'es-ES' })],
  ...partial,
});

const bilingual = content({ variants: [variant({ tag: 'es-ES' }), variant({ tag: 'en-US' })] });

describe('resolveVariant — inheritance (THE RULE)', () => {
  const media = [
    { id: 'img-1', type: 'image' as const, alt: 'A cat' },
    { id: 'img-2', type: 'image' as const, alt: 'A dog' },
  ];

  it('inherits the shared media set when the variant does not override it', () => {
    const post = content({
      media,
      variants: [variant({ tag: 'es-ES' }), variant({ tag: 'en-US' })],
    });

    expect(resolveVariant(post, 'en-US').media).toEqual(media);
  });

  it('localizes the inherited media alt text through the variant alt map', () => {
    const post = content({
      media,
      variants: [
        variant({ tag: 'es-ES' }),
        variant({ tag: 'en-US', alt: { 'img-1': 'Un gato' } }),
      ],
    });

    const resolved = resolveVariant(post, 'en-US');

    expect(resolved.media).toEqual([
      { id: 'img-1', type: 'image', alt: 'Un gato' },
      // Untouched by the alt map: keeps the shared description.
      { id: 'img-2', type: 'image', alt: 'A dog' },
    ]);
    // The shared set itself is never mutated.
    expect(post.media?.[0].alt).toBe('A cat');
  });

  it('REPLACES the media set when the variant overrides it', () => {
    const override = [{ id: 'img-en', type: 'image' as const, alt: 'English infographic' }];
    const post = content({
      media,
      variants: [variant({ tag: 'es-ES' }), variant({ tag: 'en-US', media: override })],
    });

    expect(resolveVariant(post, 'en-US').media).toEqual(override);
    expect(resolveVariant(post, 'es-ES').media).toEqual(media);
  });

  it('inherits the shared article, and merges a localized one over it', () => {
    const post = content({
      article: { articleId: 'art-1', title: 'Título', body: 'Cuerpo', excerpt: 'Extracto' },
      variants: [
        variant({ tag: 'es-ES' }),
        variant({ tag: 'en-US', article: { title: 'Title', body: 'Body', excerpt: 'Excerpt' } }),
      ],
    });

    expect(resolveVariant(post, 'es-ES').article).toEqual({
      articleId: 'art-1',
      title: 'Título',
      body: 'Cuerpo',
      excerpt: 'Extracto',
    });
    // `articleId` is NOT duplicated onto the variant — it is the same entity.
    expect(resolveVariant(post, 'en-US').article).toEqual({
      articleId: 'art-1',
      title: 'Title',
      body: 'Body',
      excerpt: 'Excerpt',
    });
  });

  it('resolves a post with no renditions to an empty body — which is what a boost has', () => {
    const boost: StoredPostContent = {};

    const resolved = resolveVariant(boost, 'en-US');

    expect(resolved.text).toBe('');
    expect(resolved.tag).toBeUndefined();
  });

  it('serves an UNTAGGED primary to everyone — its language is unknown, not English', () => {
    const post: StoredPostContent = { variants: [{ source: 'author', text: 'ok' }] };

    expect(resolveVariant(post, 'en-US').text).toBe('ok');
    expect(resolveViewerTag(['en-US'], post)).toBeUndefined();
  });
});

describe('resolveViewerTag — the resolution ladder', () => {
  it('takes an exact tag match first', () => {
    expect(resolveViewerTag(['en-US'], bilingual)).toBe('en-US');
  });

  it('falls back to any variant sharing the base subtag — an es-MX reader sees the es-ES post in Spanish', () => {
    expect(resolveViewerTag(['es-MX'], bilingual)).toBe('es-ES');
    expect(resolveVariant(bilingual, resolveViewerTag(['es-MX'], bilingual)).text).toBe('body-es-ES');
  });

  it('never serves English when Spanish exists for the reader', () => {
    // The reader prefers Spanish, then English. Spanish must win even though the
    // English variant is an exact match for the LATER candidate.
    expect(resolveViewerTag(['es-419', 'en-US'], bilingual)).toBe('es-ES');
  });

  it('walks the ladder in order: the explicit tag outranks the account locale', () => {
    // Candidates arrive already ordered: explicit `?lang`, Accept-Language, then
    // the viewer's Oxy account locales.
    expect(resolveViewerTag(['en-GB', 'es-ES'], bilingual)).toBe('en-US');
  });

  it('resolves to the primary for a reader with no language preference (anonymous, crawler, OG, MCP)', () => {
    expect(resolveViewerTag([], bilingual)).toBe('es-ES');
    expect(resolveVariant(bilingual, resolveViewerTag([], bilingual)).text).toBe('body-es-ES');
  });

  it('resolves to the primary when no candidate matches any variant', () => {
    expect(resolveViewerTag(['ja-JP'], bilingual)).toBe('es-ES');
  });

  it('ignores a malformed candidate instead of tripping over it', () => {
    expect(resolveViewerTag(['not a tag', '*', 'en-US'], bilingual)).toBe('en-US');
  });

  it('takes the primary from the FIRST author rendition — the stored order is the truth', () => {
    const englishFirst = content({ variants: [variant({ tag: 'en-US' }), variant({ tag: 'es-ES' })] });
    expect(resolveViewerTag([], englishFirst)).toBe('en-US');
    expect(getPrimaryVariant(englishFirst)?.tag).toBe('en-US');
  });
});

describe('author variants beat machine variants', () => {
  it('serves the author rendition for the same base language, even when a machine variant matches the region exactly', () => {
    const post = content({
      variants: [
        variant({ tag: 'es-ES' }),
        variant({ tag: 'es-MX', source: 'machine', text: 'traducción automática' }),
      ],
    });

    expect(resolveViewerTag(['es-MX'], post)).toBe('es-ES');
    expect(resolveVariant(post, 'es-MX').text).toBe('body-es-ES');
  });

  it('serves a machine variant when the author wrote nothing in that language', () => {
    const post = content({
      variants: [
        variant({ tag: 'es-ES' }),
        variant({ tag: 'de-DE', source: 'machine', text: 'maschinelle Übersetzung' }),
      ],
    });

    expect(resolveViewerTag(['de-DE'], post)).toBe('de-DE');
    expect(resolveVariant(post, 'de-DE').text).toBe('maschinelle Übersetzung');
  });

  it('keeps machine variants out of the post’s declared languages', () => {
    const post = content({
      variants: [
        variant({ tag: 'es-ES' }),
        variant({ tag: 'en-US' }),
        variant({ tag: 'de-DE', source: 'machine', text: 'maschinell' }),
      ],
    });

    expect(declaredBaseLanguages(post)).toEqual(['es', 'en']);
    expect(authorVariants(post).map((entry) => entry.tag)).toEqual(['es-ES', 'en-US']);
  });

  it('declares nothing for an untagged rendition', () => {
    const post: StoredPostContent = { variants: [{ source: 'author', text: 'ok' }] };
    expect(declaredBaseLanguages(post)).toEqual([]);
  });
});

describe('readerVariants — what the DTO ships', () => {
  const post = content({
    variants: [
      variant({ tag: 'es-ES' }),
      variant({ tag: 'en-US' }),
      variant({ tag: 'de-DE', source: 'machine', text: 'Hallo' }),
      variant({ tag: 'fr-FR', source: 'machine', text: 'Bonjour' }),
    ],
  });

  it('ships every author rendition plus the machine one the reader is being served', () => {
    expect(readerVariants(post, 'de-DE').map((entry) => entry.tag)).toEqual(['es-ES', 'en-US', 'de-DE']);
  });

  it('does NOT advertise the rest of the machine cache — which languages are cached is the server’s business', () => {
    expect(readerVariants(post, 'es-ES').map((entry) => entry.tag)).toEqual(['es-ES', 'en-US']);
  });
});

describe('applyDetectedPrimaryTag', () => {
  it('stamps the DETECTED language on a primary the author left untagged', () => {
    const variants = [{ source: 'author' as const, text: 'Hola mundo' }];
    expect(applyDetectedPrimaryTag(variants, 'es')[0].tag).toBe('es');
  });

  it('never overwrites a language the author DECLARED', () => {
    const variants = [variant({ tag: 'es-ES' }), variant({ tag: 'en-US' })];
    expect(applyDetectedPrimaryTag(variants, 'fr')[0].tag).toBe('es-ES');
  });

  it('leaves the primary untagged when detection resolved nothing — a guess would be federated as a declaration', () => {
    const variants = [{ source: 'author' as const, text: 'ok' }];
    expect(applyDetectedPrimaryTag(variants, undefined)[0].tag).toBeUndefined();
  });
});

describe('buildPrimaryVariant', () => {
  it('tags the body with the language that was resolved for it', () => {
    expect(buildPrimaryVariant('Hola mundo', 'es')).toMatchObject({
      tag: 'es',
      source: 'author',
      text: 'Hola mundo',
    });
  });

  it('leaves the tag ABSENT when no language could be resolved — never a guess', () => {
    const built = buildPrimaryVariant('ok', undefined);
    expect(built?.tag).toBeUndefined();
    expect(built?.text).toBe('ok');
  });

  it('builds nothing for an empty body — a boost has no rendition', () => {
    expect(buildPrimaryVariant('', 'es')).toBeUndefined();
    expect(buildPrimaryVariant('   ', 'es')).toBeUndefined();
    expect(buildPrimaryVariant(undefined, 'es')).toBeUndefined();
  });
});

describe('validateAuthorVariants', () => {
  const mediaIds = ['img-1', 'img-2'];

  it('rejects a variant that sets BOTH alt and media', () => {
    const result = validateAuthorVariants(
      [{ tag: 'en-US', text: 'hi', alt: { 'img-1': 'A cat' }, media: [{ id: 'img-en', type: 'image' }] }],
      mediaIds,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/cannot set both alt and media/);
  });

  it('canonicalizes tags and forces source to author', () => {
    const result = validateAuthorVariants([{ tag: 'es-es', text: 'hola', source: 'machine' }], mediaIds);

    expect(result.ok).toBe(true);
    expect(result.ok && result.variants[0]).toMatchObject({ tag: 'es-ES', source: 'author', text: 'hola' });
  });

  it('preserves the submitted order — the first rendition is the primary', () => {
    const result = validateAuthorVariants(
      [{ tag: 'en-US', text: 'Hello' }, { tag: 'es-ES', text: 'Hola' }],
      mediaIds,
    );

    expect(result.ok && result.variants.map((entry) => entry.tag)).toEqual(['en-US', 'es-ES']);
  });

  it('rejects an invalid language tag', () => {
    const result = validateAuthorVariants([{ tag: 'nonsense tag', text: 'hi' }], mediaIds);
    expect(result.ok).toBe(false);
  });

  it('accepts an UNTAGGED primary — the author never named the language they wrote in', () => {
    const result = validateAuthorVariants([{ text: 'ok' }], mediaIds);
    expect(result.ok).toBe(true);
    expect(result.ok && result.variants[0].tag).toBeUndefined();
  });

  it('rejects an untagged variant that is NOT the primary — nothing could ever select it', () => {
    const result = validateAuthorVariants(
      [{ tag: 'es-ES', text: 'hola' }, { text: 'hi' }],
      mediaIds,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Only the primary/);
  });

  it('rejects a SUPPLIED tag that is malformed rather than treating it as unknown', () => {
    const result = validateAuthorVariants([{ tag: 'nonsense tag', text: 'hi' }], mediaIds);
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate languages', () => {
    const result = validateAuthorVariants(
      [{ tag: 'es-ES', text: 'hola' }, { tag: 'es-es', text: 'hola de nuevo' }],
      mediaIds,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Duplicate/);
  });

  it('rejects more than the author-variant cap', () => {
    const result = validateAuthorVariants(
      [
        { tag: 'es-ES', text: 'a' },
        { tag: 'en-US', text: 'b' },
        { tag: 'it-IT', text: 'c' },
        { tag: 'fr-FR', text: 'd' },
      ],
      mediaIds,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Too many language variants/);
  });

  it('rejects a body over the post text limit', () => {
    const result = validateAuthorVariants([{ tag: 'en-US', text: 'x'.repeat(25001) }], mediaIds);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/maximum length/);
  });

  it('rejects an alt map keyed by media the post does not have', () => {
    const result = validateAuthorVariants(
      [{ tag: 'en-US', text: 'hi', alt: { 'img-ghost': 'nothing' } }],
      mediaIds,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/unknown media/);
  });

  it('accepts an alt map over the shared media set', () => {
    const result = validateAuthorVariants(
      [{ tag: 'en-US', text: 'hi', alt: { 'img-1': 'A cat' } }],
      mediaIds,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.variants[0].alt).toEqual({ 'img-1': 'A cat' });
  });

  it('treats absent variants as an empty set rather than an error', () => {
    const result = validateAuthorVariants(undefined, mediaIds);
    expect(result.ok).toBe(true);
    expect(result.ok && result.variants).toEqual([]);
  });
});
