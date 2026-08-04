/**
 * The backfill's selection rule, and the line it must not cross.
 *
 * `RE: <url>` is how Mastodon RENDERS a quote for clients that cannot show one.
 * The backfill uses it to pick CANDIDATES cheaply — re-fetching every federated
 * post ever stored would be absurd — but what decides is `extractApQuoteUri`
 * reading the structured fields off the re-fetched object, exactly as ingest
 * does. These cases pin both halves, because collapsing them would turn a filter
 * into a source of truth.
 */

import { extractApQuoteUri } from '../../connectors/activitypub/helpers';

/** Mirrors the script's candidate filter. */
const RENDERED_QUOTE_PREFIX = /^RE:\s*https?:\/\//;
const isCandidate = (body: string): boolean => RENDERED_QUOTE_PREFIX.test(body.trim());

const LEMONDE = 'https://mastodon.social/users/lemonde/statuses/117030664429761672';

describe('candidate filter', () => {
  it('picks the shape the reported post actually has', () => {
    expect(isCandidate(`RE: ${LEMONDE}\n\n* Le combat a commencé dans la rue`)).toBe(true);
    expect(isCandidate(`RE:${LEMONDE}`)).toBe(true);
  });

  it('ignores an RT, which is the OTHER case and has no reference at all', () => {
    // Bridge retweets are dropped at ingest precisely because nothing can be
    // reconstructed from them; they must never enter this lane either.
    expect(isCandidate('RT: @Julio_Rodr_ ¡Tres años!')).toBe(false);
  });

  it('ignores prose that merely opens with RE or contains a URL', () => {
    expect(isCandidate('RE: esto es una respuesta, sin enlace')).toBe(false);
    expect(isCandidate('Mira esto RE: https://example.com')).toBe(false);
    expect(isCandidate('https://example.com es interesante')).toBe(false);
  });
});

describe('the decision is structural, never the body', () => {
  it('links from the structured field on the re-fetched object', () => {
    expect(extractApQuoteUri({ quoteUri: LEMONDE })).toBe(LEMONDE);
  });

  /**
   * The load-bearing negative. A candidate whose object carries NO quote field
   * is left alone however its body opens — otherwise the `RE:` prefix would have
   * become the source of truth by the back door, and a post that merely quotes a
   * link in prose would be given a quoted post it never had.
   */
  it('leaves a candidate alone when the object carries no quote field', () => {
    expect(extractApQuoteUri({ content: `<p>RE: ${LEMONDE}</p>` })).toBeUndefined();
    expect(extractApQuoteUri({ type: 'Note', content: 'RE: something' })).toBeUndefined();
  });
});
