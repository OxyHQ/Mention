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

/**
 * The selection has to survive being expressed TWICE — once as a Mongo `$regex`
 * that pre-filters, once in JS — and the two must not disagree.
 *
 * The reason it is expressed twice at all is measured, not stylistic: the rest
 * of the query (`federation.activityId` present, `quoteOf` unset) describes
 * 611,100 of 611,607 production posts, because almost nothing is a quote.
 * Filtering the body in JS meant streaming 99.9% of the collection over the wire
 * to discard 98.5% of it — 8.5 hours at the observed rate, against 10,446
 * documents once the prefix is in the query.
 */
describe('the prefix filter is the same rule on both sides', () => {
  it('is anchored, so Mongo cannot match a body that merely contains it', () => {
    // `$regex` runs against the RAW stored value. An unanchored pattern here
    // would hand JS every post containing "RE: http" anywhere.
    expect(RENDERED_QUOTE_PREFIX.source.startsWith('^')).toBe(true);
    expect(RENDERED_QUOTE_PREFIX.test('Mira esto RE: https://example.com')).toBe(false);
  });

  it('keeps the JS check, which trims first and so is the wider of the two', () => {
    // Mongo matches the raw value; the JS check trims. A body with leading
    // whitespace therefore passes JS and not Mongo — the pre-filter may only
    // ever be NARROWER, never wider, or the database would be deciding.
    const padded = '  RE: https://mastodon.social/users/lemonde/statuses/117030664429761672';
    expect(RENDERED_QUOTE_PREFIX.test(padded)).toBe(false);
    expect(RENDERED_QUOTE_PREFIX.test(padded.trim())).toBe(true);
  });
});
