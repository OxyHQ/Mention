import { isPublicProfileHandle } from '../utils/publicProfileHandle';

/**
 * A bridge transport acct must not be a second public Mention profile URL.
 *
 * `https://mention.earth/@zuck@kilogram.makeup` rendered Zuckerberg's profile
 * even though the canonical identity the page itself shows is
 * `@zuck@instagram.com`. Both addresses reach the same account on purpose — the
 * federation layer has to resolve the protocol acct, because ActivityPub
 * addresses actors by it — but only one of them is an IDENTITY, and publishing
 * the other as a working profile URL gives one person two canonical addresses
 * and puts the bridge hostname where the reader expects a network.
 *
 * The rule is stated as a handle comparison rather than a list of bridge hosts,
 * so every entry in the backend's reviewed bridge policy inherits it without a
 * second review here — see the module's own doc comment.
 */

describe('isPublicProfileHandle — transport accts are not public identities', () => {
  it.each([
    ['the Instagram bridge', 'zuck@kilogram.makeup', 'zuck@instagram.com'],
    ['the X bridge', 'elonmusk@bird.makeup', 'elonmusk@x.com'],
    ['the mastox mirror farm', 'wired@mastox.eu', 'wired@x.com'],
    ['Bridgy Fed', 'georgemonbiot.bsky.social@bsky.brid.gy', 'georgemonbiot@bsky.social'],
  ])('refuses %s', (_label, routed, canonical) => {
    expect(isPublicProfileHandle(routed, canonical)).toBe(false);
  });

  it('refuses the transport acct however it is spelled', () => {
    expect(isPublicProfileHandle('@Zuck@Kilogram.Makeup', 'zuck@instagram.com')).toBe(false);
  });
});

describe('isPublicProfileHandle — the identities that must keep rendering', () => {
  it.each([
    ['a re-labelled Instagram account', 'zuck@instagram.com'],
    ['a re-labelled X account', 'elonmusk@x.com'],
    ['a native Threads account', 'zuck@threads.net'],
    ['an atproto account', 'georgemonbiot@bsky.social'],
    ['an ordinary fediverse account', 'gargron@mastodon.social'],
  ])('accepts %s', (_label, handle) => {
    expect(isPublicProfileHandle(handle, handle)).toBe(true);
  });

  it('ignores casing and a leading @, which a fediverse acct never distinguishes', () => {
    expect(isPublicProfileHandle('@Gargron@Mastodon.social', 'gargron@mastodon.social')).toBe(true);
  });

  /**
   * Failing OPEN here is deliberate. A resolve that answers without an identity
   * is an unexpected wire shape, not evidence that the reader typed a transport
   * address — and failing closed on it would 404 every federated profile at once.
   */
  it.each([
    ['an absent username', undefined],
    ['a null username', null],
    ['an empty username', ''],
  ])('renders anyway on %s, rather than hiding accounts we hold', (_label, resolved) => {
    expect(isPublicProfileHandle('zuck@kilogram.makeup', resolved)).toBe(true);
  });
});
