import { describe, expect, it } from 'vitest';
import { MAX_POST_DOCUMENTS } from '@mention/shared-types';
import { extractApLinkPreviews, linkPreviewKey } from '../../../connectors/activitypub/apLinkPreview';

/**
 * Reading FEP-8967 cards off an inbound Note: the text of each card, nothing a
 * reader's device would fetch, and nothing that is not a card.
 */

const card = (href: unknown, preview: Record<string, unknown> | undefined) => ({ type: 'Link', href, preview });

describe('extractApLinkPreviews', () => {
  it('reads href, name and summary, as plain text', () => {
    expect(extractApLinkPreviews({
      attachment: [card('https://foo.example/essay', {
        type: 'Article',
        name: 'Example &amp; Essay',
        summary: '<p>In which <b>some</b> information is provided</p>',
        image: { url: { href: 'https://cover-image.example/file.jpg' } },
      })],
    })).toEqual([{ url: 'https://foo.example/essay', title: 'Example & Essay', description: 'In which some information is provided' }]);
  });

  it('accepts a single attachment object, the shape in the FEP example', () => {
    expect(extractApLinkPreviews({ attachment: card('https://foo.example/', { name: 'Foo' }) }))
      .toEqual([{ url: 'https://foo.example/', title: 'Foo' }]);
  });

  it('skips media, card-less links, empty cards and non-https links', () => {
    expect(extractApLinkPreviews({
      attachment: [
        { type: 'Document', mediaType: 'image/png', url: 'https://files.example/a.png' },
        card('https://foo.example/no-card', undefined),
        card('https://foo.example/empty', { name: '  ', summary: '' }),
        card('http://foo.example/plain', { name: 'Insecure' }),
        card('javascript:alert(1)', { name: 'Script' }),
      ],
    })).toEqual([]);
  });

  it('keeps the first card for a link, however it is spelled', () => {
    const previews = extractApLinkPreviews({
      attachment: [card('https://Foo.example', { name: 'First' }), card('https://foo.example/', { name: 'Second' })],
    });
    expect(previews.map((preview) => preview.title)).toEqual(['First']);
  });

  it('caps the cards at the number a post renders, and truncates long text', () => {
    const many = Array.from({ length: MAX_POST_DOCUMENTS + 3 }, (_, i) => card(`https://foo.example/${i}`, { name: 'x'.repeat(500) }));
    const previews = extractApLinkPreviews({ attachment: many });
    expect(previews).toHaveLength(MAX_POST_DOCUMENTS);
    expect(previews[0].title?.length).toBe(300);
  });

  it('reads nothing from a note without attachments', () => {
    expect(extractApLinkPreviews({})).toEqual([]);
  });
});

describe('linkPreviewKey', () => {
  it('meets two spellings of one link and rejects a non-URL', () => {
    expect(linkPreviewKey('https://Foo.example')).toBe(linkPreviewKey('https://foo.example/'));
    expect(linkPreviewKey('not a url')).toBeUndefined();
  });
});
