/**
 * Removing the `RE: <url>` a remote server rendered for a quote WE CAN SHOW.
 *
 * The marker is not the author's prose: it is the fallback a server writes into
 * the body so clients unable to display a quote still surface the reference.
 * Once the quote is linked we render it properly, so leaving the marker shows
 * the reader the quote card AND a raw duplicate of the same link. Measured in
 * production: 16,158 of 16,324 linked federated quotes were doing exactly that
 * (14,186 with the marker leading, 1,973 trailing).
 *
 * The whole safety of this rests on matching a URL WE STORED rather than a
 * pattern, so that is what these cases pin — including the two ways it must
 * refuse.
 */

import { describe, expect, it } from 'vitest';
import { stripRenderedQuoteMarker } from '../../../connectors/activitypub/helpers';

const WEB = 'https://mastodon.social/@getkirby/116619403689196814';
const AP = 'https://mastodon.social/users/getkirby/statuses/116619403689196814';

describe('stripRenderedQuoteMarker', () => {
  it('removes a LEADING marker and the blank line it leaves', () => {
    // Mastodon's shape, and 14,186 of the affected rows.
    const body = `RE: ${WEB}\n\nI heard there are only 5 tickets left for #kirbykonf`;
    expect(stripRenderedQuoteMarker(body, [WEB]))
      .toBe('I heard there are only 5 tickets left for #kirbykonf');
  });

  it('removes a TRAILING marker, which is most of the rest of the fediverse', () => {
    // Misskey / Akkoma / Bridgy Fed / Threads append it instead — 1,973 rows.
    const body = `im gonna cry i wanna thank these people\n\nRE: ${WEB}`;
    expect(stripRenderedQuoteMarker(body, [WEB]))
      .toBe('im gonna cry i wanna thank these people');
  });

  it('matches the WEB url even when the note declared the AP id', () => {
    // The reason the caller passes several: the declared quote URI is usually
    // the AP id while the marker renders the web url, so matching only what the
    // note declared would miss almost every real case.
    const body = `RE: ${WEB}\n\nbody`;
    expect(stripRenderedQuoteMarker(body, [AP, WEB])).toBe('body');
  });

  it('tolerates a trailing slash on either side', () => {
    expect(stripRenderedQuoteMarker(`RE: ${WEB}/\n\nbody`, [WEB])).toBe('body');
  });

  it('REFUSES a `RE:` naming any other url', () => {
    // The case that stops this from being a pattern match on prose: a post that
    // merely talks about a link keeps every word of its text.
    const body = 'RE: https://example.com/something-else\n\nbody';
    expect(stripRenderedQuoteMarker(body, [WEB])).toBe(body);
  });

  it('REFUSES when nothing was linked, because then the marker is the only reference', () => {
    // The withheld (`incomplete`) path passes no urls. Removing the marker there
    // would destroy the reader's only pointer to the quoted post.
    const body = `RE: ${WEB}\n\nbody`;
    expect(stripRenderedQuoteMarker(body, [])).toBe(body);
  });

  it('leaves the author\'s own paragraph breaks alone', () => {
    const body = `RE: ${WEB}\n\nfirst para\n\nsecond para`;
    expect(stripRenderedQuoteMarker(body, [WEB])).toBe('first para\n\nsecond para');
  });
});
