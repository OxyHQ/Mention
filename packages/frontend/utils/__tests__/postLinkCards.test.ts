import type { ClarityDocument } from '@mention/shared-types/post';
import { documentByline, postLinkCards, quotedLinkUrls, withoutCardLinks } from '../postLinkCards';

const ARTICLE =
  'https://www.nytimes.com/2026/09/18/technology/google-gemini-ai.html?unlocked_article_code=1.CVE&smid=nytcore-ios-share';

describe('postLinkCards / withoutCardLinks', () => {
  it('draws no card for the quoted post and drops its bare link from the body', () => {
    const quoted = 'https://x.com/chatgpt/status/1';
    const text = `Big news\n${quoted}\n${ARTICLE}`;
    const cards = postLinkCards(text, [], [`${quoted}/`]);
    expect(cards.map((card) => card.url)).toEqual([ARTICLE]);
    expect(withoutCardLinks(text, cards, [`${quoted}/`])).toBe('Big news');
  });

  it('treats a link Clarity resolved to the quoted post as the quote, and gives it no slot', () => {
    const quoted = 'https://x.com/a/status/1';
    const alias = `${quoted}?s=20`;
    const document = { canonicalUrl: quoted, requestedUrl: alias } as ClarityDocument;
    const others = ['b', 'c', 'd', 'e'].map((host) => `https://${host}.example/`);
    const text = `${alias}\n${others.join(' ')}`;
    const aliases = quotedLinkUrls([document], [quoted]);
    expect(aliases).toEqual([quoted, alias]);
    expect(postLinkCards(text, [document], [quoted]).map((card) => card.url)).toEqual(
      others.slice(0, 4),
    );
    expect(withoutCardLinks(text, [], aliases).startsWith('https://b.example')).toBe(true);
  });

  it('draws no card for a document whose source link is the quoted post, even if it redirects', () => {
    const quoted = 'https://x.com/a/status/1';
    const document = {
      canonicalUrl: 'https://twitter.com/a/status/1',
      requestedUrl: quoted,
    } as ClarityDocument;
    expect(postLinkCards(quoted, [document], [quoted])).toEqual([]);
  });

  it('draws nothing without text or documents, and a source-less card for a document outside the text', () => {
    expect(postLinkCards(null, null)).toEqual([]);
    const document = { canonicalUrl: 'https://a.example/post' } as ClarityDocument;
    expect(postLinkCards('', [document])).toEqual([
      { url: 'https://a.example/post', sourceUrls: [], document },
    ]);
  });

  it('drops a quoted link that ends a sentence line but keeps one inside prose', () => {
    const quoted = 'https://x.com/a/status/1';
    expect(withoutCardLinks(`Look at this ${quoted}`, [], [quoted])).toBe('Look at this');
    expect(withoutCardLinks(`See ${quoted} for more`, [], [quoted])).toBe(`See ${quoted} for more`);
  });

  it('has no quote aliases without a quoted post, and ignores documents with no source link', () => {
    expect(
      quotedLinkUrls([{ canonicalUrl: 'https://x.com/a/status/1' } as ClarityDocument], []),
    ).toEqual([]);
    expect(quotedLinkUrls(null, ['https://x.com/a/status/1'])).toEqual([
      'https://x.com/a/status/1',
    ]);
    expect(
      quotedLinkUrls(
        [{ canonicalUrl: 'https://x.com/a/status/1' } as ClarityDocument],
        ['https://x.com/a/status/1'],
      ),
    ).toEqual(['https://x.com/a/status/1']);
  });

  it('drops a trailing link its card shows, even before Clarity has a document', () => {
    const text = `It’s weird how these companies confess.\n\n${ARTICLE}`;
    const cards = postLinkCards(text, []);
    expect(cards.map((card) => card.url)).toEqual([ARTICLE]);
    expect(withoutCardLinks(text, cards)).toBe('It’s weird how these companies confess.');
  });

  it('drops a link on its own line in the middle, keeping the lines around it', () => {
    const text = `Puente dimite\n${ARTICLE}\n\nPublicado en El Intermedio`;
    expect(withoutCardLinks(text, postLinkCards(text, []))).toBe(
      'Puente dimite\n\nPublicado en El Intermedio',
    );
  });

  it('keeps a link in a sentence, a written [label](url), and a link with no card', () => {
    const inSentence = `Read ${ARTICLE} before tomorrow`;
    expect(withoutCardLinks(inSentence, postLinkCards(inSentence, []))).toBe(inSentence);
    const written = `See [the article](${ARTICLE})`;
    expect(withoutCardLinks(written, postLinkCards(written, []))).toBe(written);
    const uncarded = `Line\n${ARTICLE}`;
    expect(withoutCardLinks(uncarded, [])).toBe(uncarded);
    expect(withoutCardLinks(uncarded, [{ url: 'https://other.example/', sourceUrls: [] }])).toBe(
      uncarded,
    );
  });

  it('draws one card for two links to one document and drops both bare links', () => {
    const first = 'https://video.example/watch?v=1';
    const second = `${first}&t=2s`;
    const text = `Watch this\n${first}\n\n${second}`;
    const document = { canonicalUrl: first, requestedUrl: first } as ClarityDocument;
    const cards = postLinkCards(text, [document, { ...document, requestedUrl: second }]);
    expect(cards.map(({ url, sourceUrls }) => ({ url, sourceUrls }))).toEqual([
      { url: first, sourceUrls: [first, second] },
    ]);
    expect(withoutCardLinks(text, cards)).toBe('Watch this');
  });

  it("joins a document's authors into the card's byline", () => {
    expect(
      documentByline({
        authors: [{ name: 'Kate Conger' }, { name: 'Ana Ruiz', url: 'https://example.com/ana' }],
      } as Parameters<typeof documentByline>[0]),
    ).toBe('Kate Conger, Ana Ruiz');
    expect(documentByline(undefined)).toBeUndefined();
  });
});
