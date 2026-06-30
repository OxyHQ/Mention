import { describe, expect, it } from 'vitest';

/**
 * Cross-network query classification + atproto subject predicates.
 *
 * `classifyQuery` (unified resolve) must route fediverse `user@host` accts to
 * ActivityPub, bare DNS handles / DIDs / AT-URIs to atproto, and bare local
 * usernames to the local Oxy profile path — without touching the network.
 */

import { classifyQuery } from '../../../connectors/resolve';
import { isAtUri, isAtprotoHandle, isDid } from '../../../connectors/atproto/constants';

describe('atproto subject predicates', () => {
  it('recognises did:plc and did:web identifiers', () => {
    expect(isDid('did:plc:ewvi7nxzyoun6zhxrhs64oiz')).toBe(true);
    expect(isDid('did:web:example.com')).toBe(true);
    expect(isDid('did:web:example.com:user:alice')).toBe(true);
    expect(isDid('alice.bsky.social')).toBe(false);
    expect(isDid('https://mastodon.social/users/alice')).toBe(false);
  });

  it('recognises AT-URIs', () => {
    expect(isAtUri('at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/app.bsky.feed.post/3k')).toBe(true);
    expect(isAtUri('at://alice.bsky.social/app.bsky.feed.post/3k')).toBe(true);
    expect(isAtUri('at://did:plc:ewvi7nxzyoun6zhxrhs64oiz')).toBe(true);
    expect(isAtUri('https://bsky.app/profile/alice')).toBe(false);
  });

  it('recognises bare atproto handles but never @-accts or URLs', () => {
    expect(isAtprotoHandle('alice.bsky.social')).toBe(true);
    expect(isAtprotoHandle('example.com')).toBe(true);
    // A fediverse acct (has @) is NOT an atproto handle.
    expect(isAtprotoHandle('alice@mastodon.social')).toBe(false);
    expect(isAtprotoHandle('@alice@mastodon.social')).toBe(false);
    // A bare local username (single label, no dot) is NOT a handle.
    expect(isAtprotoHandle('alice')).toBe(false);
    // A URL is NOT a handle.
    expect(isAtprotoHandle('https://example.com')).toBe(false);
  });
});

describe('classifyQuery', () => {
  it('classifies fediverse accts as activitypub', () => {
    expect(classifyQuery('@alice@mastodon.social')).toBe('activitypub');
    expect(classifyQuery('alice@mastodon.social')).toBe('activitypub');
    expect(classifyQuery('acct:alice@mastodon.social')).toBe('activitypub');
  });

  it('classifies handles, DIDs and AT-URIs as atproto', () => {
    expect(classifyQuery('alice.bsky.social')).toBe('atproto');
    expect(classifyQuery('example.com')).toBe('atproto');
    expect(classifyQuery('did:plc:ewvi7nxzyoun6zhxrhs64oiz')).toBe('atproto');
    expect(classifyQuery('did:web:example.com')).toBe('atproto');
    expect(classifyQuery('at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/app.bsky.feed.post/3k')).toBe('atproto');
  });

  it('classifies bare usernames as local', () => {
    expect(classifyQuery('@alice')).toBe('local');
    expect(classifyQuery('alice')).toBe('local');
    expect(classifyQuery('')).toBe('local');
  });
});
