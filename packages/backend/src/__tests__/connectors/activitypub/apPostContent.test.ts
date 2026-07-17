import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaItem } from '@mention/shared-types';
import type { ExtractedMediaAttachment } from '../../../connectors/shared/federatedMedia';

/**
 * Unit tests for the shared federated-note content builder — the single
 * extraction + empty-note guard both federated ingest paths (inbox `Create` and
 * outbox backfill) now share. `materializeFederatedMedia` is mocked so no
 * network/S3 I/O runs; its "permanent drop" behavior (returning empty media) is
 * simulated to exercise the media-only-post guard.
 */

const h = vi.hoisted(() => ({
  materializeFederatedMedia: vi.fn<
    (
      media: MediaItem[],
      attachments: ExtractedMediaAttachment[],
      ownerOxyUserId: string | null | undefined,
      context?: { activityId?: string; actorUri?: string },
    ) => Promise<{ media: MediaItem[]; attachments: ExtractedMediaAttachment[] }>
  >(),
}));

vi.mock('../../../connectors/shared/federatedMedia', () => ({
  materializeFederatedMedia: h.materializeFederatedMedia,
}));

import {
  buildFederatedNoteContent,
  buildFederatedNoteContentForEdit,
  extractApContentHtml,
  extractApSummary,
  rewriteHashtagAnchors,
} from '../../../connectors/activitypub/apPostContent';

beforeEach(() => {
  h.materializeFederatedMedia.mockReset();
  // Default: pass media through unchanged (nothing dropped).
  h.materializeFederatedMedia.mockImplementation(async (media, attachments) => ({ media, attachments }));
});

describe('extractApContentHtml', () => {
  it('prefers a non-empty top-level content', () => {
    expect(extractApContentHtml({ content: '<p>hi</p>', contentMap: { es: '<p>hola</p>' } })).toBe('<p>hi</p>');
  });

  it('falls back to the declared primary-language contentMap variant', () => {
    expect(
      extractApContentHtml({ content: '', language: 'es', contentMap: { en: '<p>hi</p>', es: '<p>hola</p>' } }),
    ).toBe('<p>hola</p>');
  });

  it('falls back to the first non-empty contentMap variant when no language resolves', () => {
    expect(extractApContentHtml({ content: '', contentMap: { en: '<p>hi</p>', es: '<p>hola</p>' } })).toBe('<p>hi</p>');
  });

  it('returns empty string when neither content nor contentMap is usable', () => {
    expect(extractApContentHtml({ content: '' })).toBe('');
    expect(extractApContentHtml({})).toBe('');
    expect(extractApContentHtml(null)).toBe('');
  });
});

/**
 * The AP `summary` becomes `federation.spoilerText` — the content-warning label.
 * It used to be stored raw: the code checked `.trim().length > 0` but persisted
 * the UNTRIMMED value, and never ran it through the HTML converter, so a server
 * that sends an HTML summary (the AP spec types it as an HTML string) leaked raw
 * tags into the CW label.
 */
describe('extractApSummary', () => {
  it('strips HTML from a summary', () => {
    expect(extractApSummary({ summary: '<p>CW: spoilers</p>' })).toBe('CW: spoilers');
  });

  it('collapses the whitespace of a pretty-printed HTML summary to one line', () => {
    expect(extractApSummary({ summary: '<p>\n      CW: spoilers\n    </p>' })).toBe('CW: spoilers');
  });

  it('collapses an embedded newline — a CW label is one line', () => {
    expect(extractApSummary({ summary: '  CW:\n\n  spoilers  ' })).toBe('CW: spoilers');
  });

  it('decodes entities in a summary', () => {
    expect(extractApSummary({ summary: 'caf&eacute; &amp; t&eacute;' })).toBe('café & té');
  });

  it('returns undefined for a missing, non-string, or whitespace-only summary', () => {
    expect(extractApSummary({})).toBeUndefined();
    expect(extractApSummary({ summary: '   \n  ' })).toBeUndefined();
    expect(extractApSummary({ summary: '<p>\n  \n</p>' })).toBeUndefined();
    expect(extractApSummary({ summary: 42 })).toBeUndefined();
    expect(extractApSummary(null)).toBeUndefined();
  });
});

describe('rewriteHashtagAnchors', () => {
  it('rewrites a Bridgy Fed hashtag anchor (plain-text child, bsky.app search href) to #tag', () => {
    const html =
      '<p>Climate news <a class="hashtag" rel="tag" href="https://bsky.app/search?q=%23ClimateCrisis">#ClimateCrisis</a></p>';
    expect(rewriteHashtagAnchors(html)).toBe('<p>Climate news #ClimateCrisis</p>');
  });

  it('rewrites a Mastodon hashtag anchor (inner span) to #tag — unchanged from prior behavior', () => {
    const html = '<a href="https://mastodon.social/tags/art" class="mention hashtag" rel="tag">#<span>art</span></a>';
    expect(rewriteHashtagAnchors(html)).toBe('#art');
  });

  it('leaves a non-hashtag link untouched', () => {
    const html = '<a href="https://example.com/page">example.com/page</a>';
    expect(rewriteHashtagAnchors(html)).toBe(html);
  });

  it('leaves a mention anchor untouched', () => {
    const html = '<a href="https://m.example/@alice" class="u-url mention">@alice</a>';
    expect(rewriteHashtagAnchors(html)).toBe(html);
  });

  it('is a no-op for content with no anchors', () => {
    expect(rewriteHashtagAnchors('<p>plain text</p>')).toBe('<p>plain text</p>');
  });
});

describe('buildFederatedNoteContent', () => {
  it('stores a Bridgy Fed hashtag as visible #tag text (not the bsky.app search URL) and in hashtags[]', async () => {
    const note = {
      content:
        '<p>Climate news <a class="hashtag" rel="tag" href="https://bsky.app/search?q=%23ClimateCrisis">#ClimateCrisis</a></p>',
      tag: [{ type: 'Hashtag', name: '#ClimateCrisis', href: 'https://bsky.app/search?q=%23ClimateCrisis' }],
    };
    const built = await buildFederatedNoteContent(note, 'owner-1', {});
    if (built.skip) throw new Error('expected content');
    expect(built.text).toBe('Climate news #ClimateCrisis');
    expect(built.text).not.toContain('bsky.app/search');
    expect(built.hashtags).toContain('climatecrisis');
  });

  it('normalizes the whitespace of a pretty-printed remote body', async () => {
    // The bug this whole change exists for: the indented markup a remote server
    // emits left a blank line and an indent in the stored body, which the client
    // renders verbatim (`white-space: pre-wrap`).
    const built = await buildFederatedNoteContent(
      { content: '<p>\n      Primer párrafo\n    </p>\n    <p>\n      Segundo párrafo\n    </p>' },
      'owner-1',
      {},
    );
    if (built.skip) throw new Error('expected content');
    expect(built.text).toBe('Primer párrafo\n\nSegundo párrafo');
  });

  it('stores the content warning trimmed and stripped of HTML', async () => {
    const built = await buildFederatedNoteContent(
      { content: '<p>body</p>', summary: '<p>\n      CW: spoilers\n    </p>', sensitive: true },
      'owner-1',
      {},
    );
    if (built.skip) throw new Error('expected content');
    expect(built.summary).toBe('CW: spoilers');
  });

  it('keeps a content-warning-only post and surfaces the summary as spoilerText', async () => {
    const built = await buildFederatedNoteContent(
      { content: '', summary: 'CW: spoilers ahead', sensitive: true },
      'owner-1',
      {},
    );
    expect(built.skip).toBeFalsy();
    if (built.skip) throw new Error('expected content');
    expect(built.text).toBe('');
    expect(built.summary).toBe('CW: spoilers ahead');
    expect(built.sensitive).toBe(true);
  });

  it('recovers text from a contentMap-only note (empty top-level content)', async () => {
    const built = await buildFederatedNoteContent({ content: '', contentMap: { es: '<p>hola mundo</p>' } }, 'owner-1', {});
    expect(built.skip).toBeFalsy();
    if (built.skip) throw new Error('expected content');
    expect(built.text).toBe('hola mundo');
  });

  it('skips a media-only note whose only attachment was dropped as permanently unavailable', async () => {
    // Simulate materialization permanently dropping the sole remote image.
    h.materializeFederatedMedia.mockResolvedValue({ media: [], attachments: [] });

    const built = await buildFederatedNoteContent(
      {
        content: '',
        attachment: [{ type: 'Document', mediaType: 'image/png', url: 'https://remote.example/a.png' }],
      },
      'owner-1',
      {},
    );
    expect(built.skip).toBe(true);
    if (!built.skip) throw new Error('expected skip');
    expect(built.reason).toBe('empty-federated-note');
  });

  it('keeps an all-hashtag note: tags captured and the body is not blanked', async () => {
    const built = await buildFederatedNoteContent({ content: '<p>#art #photo #nature #travel</p>' }, 'owner-1', {});
    expect(built.skip).toBeFalsy();
    if (built.skip) throw new Error('expected content');
    expect(built.hashtags).toEqual(expect.arrayContaining(['art', 'photo', 'nature', 'travel']));
    // The spammy block would normalize to empty text; the builder restores the
    // raw hashtag text rather than blanking the post.
    expect(built.text.trim().length).toBeGreaterThan(0);
  });

  it('skips a genuinely empty note (no text, no media, no attachments, no summary)', async () => {
    const built = await buildFederatedNoteContent({ content: '' }, 'owner-1', {});
    expect(built.skip).toBe(true);
    if (!built.skip) throw new Error('expected skip');
    expect(built.reason).toBe('empty-federated-note');
  });

  it('produces identical stored text for the same object (inbox/outbox symmetry)', async () => {
    // Both the inbox Create path and the outbox backfill now call this one
    // builder, so a hashtag-bearing note stores the SAME normalized body on both
    // paths. Before the fix, only the outbox path ran hashtag normalization.
    const object = { content: '<p>Hello world #a #b #c #d</p>' };
    const first = await buildFederatedNoteContent(object, 'owner-1', {});
    const second = await buildFederatedNoteContent(object, 'owner-1', {});
    if (first.skip || second.skip) throw new Error('expected content');
    expect(first.text).toBe('Hello world #a');
    expect(second.text).toBe(first.text);
    expect(second.hashtags).toEqual(first.hashtags);
  });
});

describe('buildFederatedNoteContentForEdit', () => {
  it('recovers text from an edited contentMap-only note', async () => {
    const built = await buildFederatedNoteContentForEdit(
      { content: '', contentMap: { es: '<p>texto editado</p>' } },
      'owner-1',
      {},
    );
    expect(built.text).toBe('texto editado');
  });

  it('surfaces the content-warning summary and sensitive flag on an edited CW note', async () => {
    const built = await buildFederatedNoteContentForEdit(
      { content: '<p>body</p>', summary: 'CW: edited warning', sensitive: true },
      'owner-1',
      {},
    );
    expect(built.text).toBe('body');
    expect(built.summary).toBe('CW: edited warning');
    expect(built.sensitive).toBe(true);
  });

  it('does NOT skip a genuinely empty edit — an edit applies (never drops) its fields', async () => {
    // Create semantics would SKIP this; edit semantics must return applicable
    // (empty) fields so a legitimate clear is written to the existing post.
    const built = await buildFederatedNoteContentForEdit({ content: '' }, 'owner-1', {});
    expect(built.text).toBe('');
    expect(built.media).toEqual([]);
    expect(built.attachments).toEqual([]);
    expect(built.summary).toBeUndefined();
  });

  it('matches the create builder’s extraction for a non-empty note (shared assembly)', async () => {
    // The edit and create paths share one assembler, so a note that passes the
    // create guard extracts identically on both.
    const object = { content: '<p>Hello world #a #b #c #d</p>' };
    const created = await buildFederatedNoteContent(object, 'owner-1', {});
    const edited = await buildFederatedNoteContentForEdit(object, 'owner-1', {});
    if (created.skip) throw new Error('expected content');
    expect(edited.text).toBe(created.text);
    expect(edited.hashtags).toEqual(created.hashtags);
  });
});

describe('multilingual ingest — a contentMap is one body PER LANGUAGE, not a fallback', () => {
  it('persists EVERY localized body of a bilingual status as an author variant, primary first', async () => {
    // Mastodon's own multilingual posts look exactly like this: a top-level
    // `content` + `language` naming the primary, and a `contentMap` carrying one
    // body per language. The old extraction collapsed the map to a single string
    // and threw the other body away.
    const built = await buildFederatedNoteContent(
      {
        content: '<p>hola mundo</p>',
        language: 'es',
        contentMap: { es: '<p>hola mundo</p>', en: '<p>hello world</p>' },
      },
      'owner-1',
      {},
    );
    if (built.skip) throw new Error('expected content');

    // `variants[0]` IS the primary — there is no stored `content.text` for it to
    // mirror. `built.text` is the extraction's primary body (what the empty-note
    // guard and the classifier read), and it is the same string by construction.
    expect(built.variants).toEqual([
      { tag: 'es', source: 'author', text: 'hola mundo' },
      { tag: 'en', source: 'author', text: 'hello world' },
    ]);
    expect(built.text).toBe('hola mundo');
  });

  it('leads with the primary even when the contentMap declares it second', async () => {
    const built = await buildFederatedNoteContent(
      {
        content: '<p>hello</p>',
        language: 'en',
        contentMap: { es: '<p>hola</p>', en: '<p>hello</p>' },
      },
      'owner-1',
      {},
    );
    if (built.skip) throw new Error('expected content');

    expect(built.variants.map((variant) => variant.tag)).toEqual(['en', 'es']);
  });

  it('caps the author variants at 3 — a hostile origin cannot grow a post without bound', async () => {
    const built = await buildFederatedNoteContent(
      {
        content: '<p>one</p>',
        language: 'en',
        contentMap: {
          en: '<p>one</p>',
          es: '<p>uno</p>',
          fr: '<p>un</p>',
          de: '<p>eins</p>',
          it: '<p>uno (it)</p>',
        },
      },
      'owner-1',
      {},
    );
    if (built.skip) throw new Error('expected content');

    expect(built.variants).toHaveLength(3);
    expect(built.variants.map((variant) => variant.tag)).toEqual(['en', 'es', 'fr']);
  });

  it('stores the single declared language of a monolingual note as its primary variant', async () => {
    const built = await buildFederatedNoteContent({ content: '<p>hello</p>', language: 'en' }, 'owner-1', {});
    if (built.skip) throw new Error('expected content');

    expect(built.variants).toEqual([{ tag: 'en', source: 'author', text: 'hello' }]);
  });

  it('strips HTML and normalizes hashtags in a NON-primary body too — never stores raw markup', async () => {
    const built = await buildFederatedNoteContent(
      {
        content: '<p>hello</p>',
        language: 'en',
        contentMap: { en: '<p>hello</p>', es: '<p>hola\n     mundo</p>' },
      },
      'owner-1',
      {},
    );
    if (built.skip) throw new Error('expected content');

    expect(built.variants[1]).toEqual({ tag: 'es', source: 'author', text: 'hola\nmundo' });
  });

  it('rejects an invalid BCP-47 contentMap key rather than storing an unusable tag', async () => {
    const built = await buildFederatedNoteContent(
      {
        content: '<p>hello</p>',
        language: 'en',
        contentMap: { en: '<p>hello</p>', 'not a language': '<p>garbage</p>' },
      },
      'owner-1',
      {},
    );
    if (built.skip) throw new Error('expected content');

    expect(built.variants.map((variant) => variant.tag)).toEqual(['en']);
  });

  it('stores an UNTAGGED primary variant when the origin declared no language', async () => {
    // The common case for non-Mastodon AP servers (Lemmy, PeerTube, bots): no
    // `language`, no `contentMap`. The body is still the post and must be kept.
    // Inventing a tag from a detector's guess would federate that lie onward.
    const built = await buildFederatedNoteContent({ content: '<p>hello</p>' }, 'owner-1', {});
    if (built.skip) throw new Error('expected content');

    expect(built.variants).toEqual([{ source: 'author', text: 'hello' }]);
    expect(built.variants[0].tag).toBeUndefined();
  });

  it('stores NO variant for a note with no body at all (media-only)', async () => {
    h.materializeFederatedMedia.mockResolvedValue({
      media: [{ id: 'file-1', type: 'image' }],
      attachments: [],
    });
    const built = await buildFederatedNoteContent(
      { content: '', attachment: [{ type: 'Document', url: 'https://x/y.png', mediaType: 'image/png' }] },
      'owner-1',
      {},
    );
    if (built.skip) throw new Error('expected content');

    // No rendition, in any language — not an empty-string one.
    expect(built.variants).toEqual([]);
    expect(built.media).toHaveLength(1);
  });

  it('canonicalizes a regional tag (`pt-br` → `pt-BR`) — no raw string enters the model', async () => {
    const built = await buildFederatedNoteContent(
      { content: '<p>ola</p>', language: 'pt-br' },
      'owner-1',
      {},
    );
    if (built.skip) throw new Error('expected content');

    expect(built.variants[0].tag).toBe('pt-BR');
  });
});
