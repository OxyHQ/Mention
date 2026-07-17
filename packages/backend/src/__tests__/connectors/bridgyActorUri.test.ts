import { describe, it, expect } from 'vitest';

/**
 * Bridgy Fed identity derivation. Bridgy Fed bridges a Bluesky user onto
 * ActivityPub at the DETERMINISTIC actor URI `https://bsky.brid.gy/ap/<did>` and
 * wraps a post's AT-URI as `https://bsky.brid.gy/convert/ap/at://<did>/...`. A
 * legacy orphan that stored only the wrapped object URL can therefore recover its
 * author's actor URI with no network round trip.
 */

import {
  bridgedMentionAnchorHrefs,
  deriveBridgyActorUri,
  didFromBridgyActorUri,
} from '../../connectors/activitypub/bridgy';
import { didFromAtUri } from '../../connectors/atproto/constants';

const DID = 'did:plc:reu7q3altx5gsonhu5nxcfp6';
const CONVERT_URL = `https://bsky.brid.gy/convert/ap/at://${DID}/app.bsky.feed.post/3moysdeqo3c2r`;
const BRIDGY_ACTOR = `https://bsky.brid.gy/ap/${DID}`;

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

describe('didFromBridgyActorUri', () => {
  it('extracts the DID from a brid.gy actor URI', () => {
    expect(didFromBridgyActorUri(BRIDGY_ACTOR)).toBe(DID);
  });

  it('extracts a did:web authority', () => {
    expect(didFromBridgyActorUri('https://bsky.brid.gy/ap/did:web:example.com')).toBe('did:web:example.com');
  });

  it('rejects a non-brid.gy host', () => {
    expect(didFromBridgyActorUri(`https://example.com/ap/${DID}`)).toBeUndefined();
  });

  it('rejects a brid.gy URL whose path is not /ap/<did>', () => {
    expect(didFromBridgyActorUri(CONVERT_URL)).toBeUndefined();
    expect(didFromBridgyActorUri('https://bsky.brid.gy/ap/not-a-did')).toBeUndefined();
  });

  it('returns undefined for a non-URL', () => {
    expect(didFromBridgyActorUri('not a url')).toBeUndefined();
  });
});

describe('bridgedMentionAnchorHrefs', () => {
  it('derives both bsky.app profile forms from a brid.gy Mention tag (did + handle)', () => {
    expect(
      bridgedMentionAnchorHrefs({ href: BRIDGY_ACTOR, name: '@alice.bsky.social@bsky.brid.gy' }),
    ).toEqual([
      `https://bsky.app/profile/${DID}`,
      'https://bsky.app/profile/alice.bsky.social',
    ]);
  });

  it('derives only the did form when the tag carries no name', () => {
    expect(bridgedMentionAnchorHrefs({ href: BRIDGY_ACTOR })).toEqual([
      `https://bsky.app/profile/${DID}`,
    ]);
  });

  it('returns [] for a non-brid.gy mention tag', () => {
    expect(
      bridgedMentionAnchorHrefs({ href: 'https://mastodon.social/users/bob', name: '@bob@mastodon.social' }),
    ).toEqual([]);
  });
});
