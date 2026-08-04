/**
 * A quote of a post we do not already hold.
 *
 * The quote URI has been read from the standard AP surfaces for a while — what
 * was missing is that nothing ever FETCHED the quoted post. `quoteOf` resolved
 * only against posts already imported and was left null otherwise, under a
 * comment promising it would "link on a later pass once the original is
 * ingested" while nothing existed to ingest it.
 *
 * Seen live on https://mention.earth/p/6a70af06eb414d99383a49ac: three fields
 * (`quote`, `quoteUri`, `_misskey_quote`) all naming
 * https://mastodon.social/users/lemonde/statuses/117030664429761672, and the
 * post rendered as a bare `RE: <url>` with no quote at all.
 */

import { extractApQuoteUri } from '../../../connectors/activitypub/helpers';

const LEMONDE = 'https://mastodon.social/users/lemonde/statuses/117030664429761672';

describe('extractApQuoteUri — the surfaces a real quote arrives on', () => {
  it('reads the three fields Mastodon sent on the reported post, agreeing', () => {
    // All three carry the same value in practice; each is asserted separately so
    // a regression that drops one is not hidden by the others.
    expect(extractApQuoteUri({ quote: LEMONDE })).toBe(LEMONDE);
    expect(extractApQuoteUri({ quoteUri: LEMONDE })).toBe(LEMONDE);
    expect(extractApQuoteUri({ _misskey_quote: LEMONDE })).toBe(LEMONDE);
  });

  it('reads the Pleroma/Akkoma spelling too', () => {
    expect(extractApQuoteUri({ quoteUrl: LEMONDE })).toBe(LEMONDE);
  });

  it('reads the FEP-e232 Link tag', () => {
    expect(extractApQuoteUri({
      tag: [{ type: 'Link', mediaType: 'application/activity+json', href: LEMONDE }],
    })).toBe(LEMONDE);
  });

  it('answers undefined for an ordinary post, so nothing is fetched', () => {
    // The common case by far: one wrong match here would fetch a URL off every
    // incoming Note.
    expect(extractApQuoteUri({ content: '<p>RE: something, but not a quote</p>' })).toBeUndefined();
    expect(extractApQuoteUri({})).toBeUndefined();
  });

  it('does not read a quote out of the BODY, even when it looks like one', () => {
    // `RE: <url>` in the content is how Mastodon RENDERS a quote for clients that
    // cannot show one — it is a symptom, not the source. Reading it would be
    // parsing prose to decide structure, and would fire on any post that happens
    // to open that way.
    expect(extractApQuoteUri({ content: `<p>RE: ${LEMONDE}</p>` })).toBeUndefined();
  });
});
