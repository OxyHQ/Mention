import { documentByline, postLinkCards, withoutCardLinks } from '../postLinkCards';

const ARTICLE =
  'https://www.nytimes.com/2026/09/18/technology/google-gemini-ai.html?unlocked_article_code=1.CVE&smid=nytcore-ios-share';

describe('postLinkCards / withoutCardLinks', () => {
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
    expect(withoutCardLinks(uncarded, [{ url: 'https://other.example/' }])).toBe(uncarded);
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
