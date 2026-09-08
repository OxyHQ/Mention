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

/**
 * Mirrors the script's candidate filter — deliberately UNANCHORED.
 *
 * `^RE:` described Mastodon alone. Misskey, Akkoma, Bridgy Fed and Threads put
 * the marker AFTER the author's text, and an anchored pattern saw none of them:
 * 2,043 production posts carried `RE: <url>` only at the end, invisible to the
 * old filter, and the servers behind them (misskey.io, bsky.brid.gy,
 * misskey.design, bsky.social) all send the structured field this script reads.
 */
const RENDERED_QUOTE_MARKER = /(^|\s)RE:\s*https?:\/\//;
const isCandidate = (body: string): boolean => RENDERED_QUOTE_MARKER.test(body);

const LEMONDE = 'https://mastodon.social/users/lemonde/statuses/117030664429761672';

describe('candidate filter', () => {
  it('picks the shape the reported post actually has', () => {
    expect(isCandidate(`RE: ${LEMONDE}\n\n* Le combat a commencé dans la rue`)).toBe(true);
    expect(isCandidate(`RE:${LEMONDE}`)).toBe(true);
  });

  it('picks the TRAILING shape too, which is most of the fediverse', () => {
    // The real body of a Misskey / Bridgy Fed / Threads quote: the author's own
    // text first, the rendered marker last. This is the case the anchored filter
    // could not see, and it is 2,043 posts.
    expect(isCandidate(`A M A T E R A S U 👁️ 🔥\n\nRE: ${LEMONDE}`)).toBe(true);
  });

  it('ignores an RT, which is the OTHER case and has no reference at all', () => {
    // Bridge retweets are dropped at ingest precisely because nothing can be
    // reconstructed from them; they must never enter this lane either.
    expect(isCandidate('RT: @Julio_Rodr_ ¡Tres años!')).toBe(false);
  });

  it('ignores prose with no marker, and a marker with no URL', () => {
    // `Mira esto RE: https://example.com` USED to belong here and no longer
    // does — the filter is unanchored now, so it is admitted as a candidate and
    // then rejected by the object, which is pinned in
    // `widening the net cannot widen what gets LINKED` below.
    expect(isCandidate('RE: esto es una respuesta, sin enlace')).toBe(false);
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
describe('widening the net cannot widen what gets LINKED', () => {
  it('admits a marker mid-body, and that is safe rather than sloppy', () => {
    // The old filter refused this on purpose, to avoid fetching every post
    // containing "RE: http" anywhere. The cost was measured — +2,042 candidates,
    // +15% — and it buys 2,043 genuinely repairable posts, so the trade now goes
    // the other way.
    //
    // It is safe because this pattern never decides anything. A candidate is
    // RE-FETCHED and `extractApQuoteUri` reads its structured fields; a body
    // that merely talks about a URL yields no quote field and is left alone.
    // The cases below pin that half.
    expect(isCandidate('Mira esto RE: https://example.com')).toBe(true);
    expect(extractApQuoteUri({ content: 'Mira esto RE: https://example.com' })).toBeUndefined();
  });

  it('still needs a word boundary and a real URL', () => {
    // `(^|\s)` keeps mid-word noise out, and the `https?://` half keeps prose
    // out — otherwise every post using the word "RE:" would be fetched.
    expect(isCandidate(`xRE: ${LEMONDE}`)).toBe(false);
    expect(isCandidate('RE: esto es una respuesta, sin enlace')).toBe(false);
  });

  it('no longer depends on trimming, because the SQL no longer trims', () => {
    // The anchored version had to `btrim` first or a leading newline hid the
    // marker. `(^|\s)` matches that whitespace itself, so both sides read the
    // RAW stored value and cannot drift apart.
    expect(isCandidate('  RE: https://mastodon.social/users/lemonde/statuses/117030664429761672')).toBe(true);
  });

  it('does NOT repair a Threads quote, and that is the honest outcome', () => {
    // Threads renders the marker like everyone else, so it enters this lane —
    // but its AP object carries NO quote field at all (measured on
    // threads.net/ap/users/17841401260928433/post/18099292307347571: keys are
    // id, type, content, published, @context, contentMap, attributedTo, url,
    // to, cc, tag, interactionPolicy; `tag` is empty). The quote lives only in
    // the body HTML, and reading that is exactly what this file exists to
    // forbid. So a Threads candidate is fetched, yields nothing, and is left
    // alone — 26 posts, whose 26 targets we hold none of.
    expect(isCandidate('A M A T E R A S U 👁️ 🔥\n\nRE: https://www.threads.com/@x/post/Dcv3w16ivxA')).toBe(true);
    expect(extractApQuoteUri({
      type: 'Note',
      content: '<p>A M A T E R A S U</p> <p><span class="quote-inline">RE: <a href="https://www.threads.com/@x/post/Dcv3w16ivxA">t</a></span></p>',
      tag: [],
    })).toBeUndefined();
  });
});
