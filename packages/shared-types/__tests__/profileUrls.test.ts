import { describe, expect, it } from 'bun:test';
import { localProfilePathHandle, ownProfileUrlHandle } from '../src/profileUrls';

/** The instance under test, as a caller would supply its own web origin. */
const OURS = ['mention.earth'];

describe('localProfilePathHandle — the path shapes a profile lives at', () => {
  it('reads the human profile page', () => {
    expect(localProfilePathHandle('https://mention.earth/@alice')).toBe('alice');
  });

  it('reads our minted actor URI', () => {
    expect(localProfilePathHandle('https://mention.earth/ap/users/alice')).toBe('alice');
  });

  it('reads a federated profile as WE publish it, `@` and all', () => {
    // Our own federated profile URLs carry the whole `user@host` in one segment.
    // A username character class would cut it at the inner `@` and claim the
    // remote user as a local one.
    expect(localProfilePathHandle('https://mention.earth/@bob@mastodon.social')).toBe(
      'bob@mastodon.social',
    );
  });

  it('tolerates a trailing slash', () => {
    expect(localProfilePathHandle('https://mention.earth/@alice/')).toBe('alice');
  });

  it('is not a profile once the path goes deeper', () => {
    // A sub-page is a different document; a reader who taps it wants that page.
    expect(localProfilePathHandle('https://mention.earth/@alice/followers')).toBeUndefined();
    expect(localProfilePathHandle('https://mention.earth/ap/users/alice/outbox')).toBeUndefined();
  });

  it('is not a profile for any other path', () => {
    expect(localProfilePathHandle('https://mention.earth/p/abc123')).toBeUndefined();
    expect(localProfilePathHandle('https://mention.earth/')).toBeUndefined();
    expect(localProfilePathHandle('https://mention.earth/@')).toBeUndefined();
  });

  it('returns undefined rather than throwing on a non-URL', () => {
    expect(localProfilePathHandle('not a url')).toBeUndefined();
    expect(localProfilePathHandle('')).toBeUndefined();
  });

  it('has no opinion about the host — that is the caller`s gate', () => {
    // Documenting the hazard the two-function split exists to prevent: this
    // function will happily read a stranger`s path.
    expect(localProfilePathHandle('https://mastodon.social/@bob')).toBe('bob');
  });
});

describe('ownProfileUrlHandle — only a profile on one of OUR hosts', () => {
  it('accepts our own profile and actor URLs', () => {
    expect(ownProfileUrlHandle('https://mention.earth/@alice', OURS)).toBe('alice');
    expect(ownProfileUrlHandle('https://mention.earth/ap/users/alice', OURS)).toBe('alice');
  });

  it('REFUSES the identical path on somebody else`s host', () => {
    // The load-bearing assertion. Without the host gate this returns `bob`, and a
    // link to bob-on-mastodon becomes a mention of whoever holds `bob` here.
    expect(ownProfileUrlHandle('https://mastodon.social/@bob', OURS)).toBeUndefined();
    expect(ownProfileUrlHandle('https://x.com/elonmusk', OURS)).toBeUndefined();
    expect(ownProfileUrlHandle('https://bsky.app/profile/alice.bsky.social', OURS)).toBeUndefined();
  });

  it('refuses a host that merely ends with ours', () => {
    expect(ownProfileUrlHandle('https://notmention.earth/@alice', OURS)).toBeUndefined();
    expect(ownProfileUrlHandle('https://mention.earth.evil.test/@alice', OURS)).toBeUndefined();
  });

  it('treats `www.` as the same host, on either side of the comparison', () => {
    expect(ownProfileUrlHandle('https://www.mention.earth/@alice', OURS)).toBe('alice');
    expect(ownProfileUrlHandle('https://mention.earth/@alice', ['www.mention.earth'])).toBe('alice');
  });

  it('is case-insensitive about the host and only the host', () => {
    expect(ownProfileUrlHandle('https://MENTION.EARTH/@Alice', OURS)).toBe('Alice');
  });

  it('keeps our own federated profile URLs whole', () => {
    expect(ownProfileUrlHandle('https://mention.earth/@bob@mastodon.social', OURS)).toBe(
      'bob@mastodon.social',
    );
  });

  it('drops a query string and fragment, which are never part of a handle', () => {
    expect(ownProfileUrlHandle('https://mention.earth/@alice?utm_source=x', OURS)).toBe('alice');
    expect(ownProfileUrlHandle('https://mention.earth/@alice#bio', OURS)).toBe('alice');
  });

  it('accepts http as well as https', () => {
    expect(ownProfileUrlHandle('http://mention.earth/@alice', OURS)).toBe('alice');
  });

  it('refuses a non-http scheme even on our own host', () => {
    expect(ownProfileUrlHandle('javascript:alert(1)', OURS)).toBeUndefined();
    expect(ownProfileUrlHandle('ftp://mention.earth/@alice', OURS)).toBeUndefined();
  });

  it('percent-decodes the handle, because this one is read by a person', () => {
    expect(ownProfileUrlHandle('https://mention.earth/@caf%C3%A9', OURS)).toBe('café');
  });

  it('refuses a handle no profile route would accept', () => {
    // `getNormalizedUserHandle` rejects `/ ? #`, so a handle carrying one would
    // render as inert coloured text where a working link used to be.
    expect(ownProfileUrlHandle('https://mention.earth/@a%2Fb', OURS)).toBeUndefined();
    expect(ownProfileUrlHandle('https://mention.earth/@a%3Fb', OURS)).toBeUndefined();
    expect(ownProfileUrlHandle('https://mention.earth/@a%23b', OURS)).toBeUndefined();
  });

  it('refuses a segment that does not decode', () => {
    expect(ownProfileUrlHandle('https://mention.earth/@%E0%A4%A', OURS)).toBeUndefined();
  });

  it('refuses a segment that decodes to nothing', () => {
    expect(ownProfileUrlHandle('https://mention.earth/@%20', OURS)).toBeUndefined();
    expect(ownProfileUrlHandle('https://mention.earth/@%40', OURS)).toBeUndefined();
  });

  it('converts nothing at all when the caller declares no hosts', () => {
    // A build with an unparseable web base URL must leave links as links rather
    // than mint mentions against a host nobody declared.
    expect(ownProfileUrlHandle('https://mention.earth/@alice', [])).toBeUndefined();
  });
});
