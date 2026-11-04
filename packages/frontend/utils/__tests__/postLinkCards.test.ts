import { postLinkCards, withoutTrailingCardLink } from '../postLinkCards';

const ARTICLE =
  'https://www.nytimes.com/2026/09/18/technology/google-gemini-ai.html?unlocked_article_code=1.CVE&smid=nytcore-ios-share';

describe('postLinkCards / withoutTrailingCardLink', () => {
  it('drops a trailing link its card shows, even before Clarity has a document', () => {
    const text = `It’s weird how these companies confess.\n\n${ARTICLE}`;
    const cards = postLinkCards(text, []);
    expect(cards.map((card) => card.url)).toEqual([ARTICLE]);
    expect(withoutTrailingCardLink(text, cards)).toBe('It’s weird how these companies confess.');
  });

  it('keeps a link that is part of a sentence', () => {
    const text = `Read ${ARTICLE} before tomorrow`;
    expect(withoutTrailingCardLink(text, postLinkCards(text, []))).toBe(text);
  });
});
