import { describe, it, expect } from 'vitest';
import { extractApQuoteUri } from '../../../connectors/activitypub/helpers';

/**
 * Inbound quote extraction. A federated Note advertises the post it QUOTES across
 * several interoperating terms — the modern `quote`/`quoteUri` (FEP-044f /
 * Mastodon 4.4+), the legacy `_misskey_quote`/`quoteUrl` (Misskey/Pleroma), and
 * the FEP-e232 `Link` quote tag. Bridgy Fed bridges a Bluesky quote through these
 * same fields, pointing at the quoted post's wrapped brid.gy object URL. The
 * caller resolves the returned URI to a local Post via `resolvePostIdFromObjectUri`.
 */

const DID = 'did:plc:reu7q3altx5gsonhu5nxcfp6';
const QUOTED = `https://bsky.brid.gy/convert/ap/at://${DID}/app.bsky.feed.post/3quotedrkey`;

describe('extractApQuoteUri', () => {
  it('reads the FEP-044f `quote` field', () => {
    expect(extractApQuoteUri({ quote: QUOTED })).toBe(QUOTED);
  });

  it('reads `quoteUri`, `quoteUrl`, and `_misskey_quote`', () => {
    expect(extractApQuoteUri({ quoteUri: QUOTED })).toBe(QUOTED);
    expect(extractApQuoteUri({ quoteUrl: QUOTED })).toBe(QUOTED);
    expect(extractApQuoteUri({ _misskey_quote: QUOTED })).toBe(QUOTED);
  });

  it('reads an embedded object under a quote field (`{id}` / `{href}`)', () => {
    expect(extractApQuoteUri({ quote: { id: QUOTED } })).toBe(QUOTED);
    expect(extractApQuoteUri({ quoteUrl: { href: QUOTED } })).toBe(QUOTED);
  });

  it('reads a FEP-e232 `Link` quote tag by the misskey quote rel', () => {
    const object = {
      tag: [
        { type: 'Mention', href: 'https://bsky.brid.gy/ap/did:plc:someone', name: '@a@bsky.brid.gy' },
        {
          type: 'Link',
          mediaType: 'application/activity+json',
          href: QUOTED,
          name: `RE: ${QUOTED}`,
          rel: 'https://misskey-hub.net/ns#_misskey_quote',
        },
      ],
    };
    expect(extractApQuoteUri(object)).toBe(QUOTED);
  });

  it('reads a FEP-e232 `Link` quote tag by the AP mediaType alone', () => {
    const object = {
      tag: [{ type: 'Link', mediaType: 'application/activity+json', href: QUOTED }],
    };
    expect(extractApQuoteUri(object)).toBe(QUOTED);
  });

  it('prefers a structured quote field over the tag', () => {
    const other = `https://bsky.brid.gy/convert/ap/at://${DID}/app.bsky.feed.post/3othertag`;
    const object = {
      quoteUrl: QUOTED,
      tag: [{ type: 'Link', mediaType: 'application/activity+json', href: other }],
    };
    expect(extractApQuoteUri(object)).toBe(QUOTED);
  });

  it('ignores a non-quote Link tag (e.g. a plain web link)', () => {
    const object = {
      tag: [{ type: 'Link', mediaType: 'text/html', href: 'https://example.com/page' }],
    };
    expect(extractApQuoteUri(object)).toBeUndefined();
  });

  it('returns undefined for a note that quotes nothing', () => {
    expect(extractApQuoteUri({ content: '<p>no quote here</p>' })).toBeUndefined();
    expect(extractApQuoteUri({})).toBeUndefined();
  });

  it('ignores a non-http quote value', () => {
    expect(extractApQuoteUri({ quote: `at://${DID}/app.bsky.feed.post/x` })).toBeUndefined();
  });
});
