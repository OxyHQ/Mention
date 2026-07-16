import { describe, it, expect } from 'vitest';

/**
 * Bridgy Fed identity derivation. Bridgy Fed bridges a Bluesky user onto
 * ActivityPub at the DETERMINISTIC actor URI `https://bsky.brid.gy/ap/<did>` and
 * wraps a post's AT-URI as `https://bsky.brid.gy/convert/ap/at://<did>/...`. A
 * legacy orphan that stored only the wrapped object URL can therefore recover its
 * author's actor URI with no network round trip.
 */

import { deriveBridgyActorUri } from '../../connectors/activitypub/bridgy';
import { didFromAtUri } from '../../connectors/atproto/constants';

const DID = 'did:plc:reu7q3altx5gsonhu5nxcfp6';
const CONVERT_URL = `https://bsky.brid.gy/convert/ap/at://${DID}/app.bsky.feed.post/3moysdeqo3c2r`;

describe('didFromAtUri', () => {
  it('extracts the DID from a bare AT-URI', () => {
    expect(didFromAtUri(`at://${DID}/app.bsky.feed.post/3moysdeqo3c2r`)).toBe(DID);
  });

  it('extracts the DID embedded in a wrapped brid.gy object URL', () => {
    expect(didFromAtUri(CONVERT_URL)).toBe(DID);
  });

  it('extracts a did:web authority', () => {
    expect(didFromAtUri('at://did:web:example.com/app.bsky.feed.post/abc')).toBe('did:web:example.com');
  });

  it('rejects a handle authority (no stable DID)', () => {
    expect(didFromAtUri('at://alice.bsky.social/app.bsky.feed.post/abc')).toBeUndefined();
  });

  it('returns undefined when no at:// DID is present', () => {
    expect(didFromAtUri('https://mastodon.online/@alice/12345')).toBeUndefined();
  });
});

describe('deriveBridgyActorUri', () => {
  it('derives the canonical actor URI from a wrapped brid.gy object URL', () => {
    expect(deriveBridgyActorUri(CONVERT_URL)).toBe(`https://bsky.brid.gy/ap/${DID}`);
  });

  it('tries each candidate in order (activityId, then url)', () => {
    expect(deriveBridgyActorUri(undefined, CONVERT_URL)).toBe(`https://bsky.brid.gy/ap/${DID}`);
  });

  it('rejects a non-brid.gy host even when it carries an at:// DID', () => {
    expect(deriveBridgyActorUri(`https://example.com/convert/ap/at://${DID}/app.bsky.feed.post/x`)).toBeUndefined();
  });

  it('rejects a bare at:// URI (no brid.gy host to build from)', () => {
    expect(deriveBridgyActorUri(`at://${DID}/app.bsky.feed.post/x`)).toBeUndefined();
  });

  it('returns undefined for a non-federated Mastodon URL', () => {
    expect(deriveBridgyActorUri('https://mastodon.online/@alice/12345')).toBeUndefined();
  });

  it('returns undefined for empty / undefined input', () => {
    expect(deriveBridgyActorUri(undefined, undefined)).toBeUndefined();
    expect(deriveBridgyActorUri()).toBeUndefined();
  });
});
