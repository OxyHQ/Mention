import { isPublicProfileHandle } from '../utils/publicProfileHandle';

/** Oxy owns public network identities; transport delivery accts cannot grant routes. */

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

  it.each([
    ['an absent username', undefined],
    ['a null username', null],
    ['an empty username', ''],
  ])('refuses %s without a public identity', (_label, resolved) => {
    expect(isPublicProfileHandle('zuck@kilogram.makeup', resolved)).toBe(false);
  });
});


describe('Oxy-proven aliases', () => {
  const profile = { externalIdentities: [{ canonicalAcct: 'freshperson@threads.net', network: 'threads.net', protocol: 'activitypub', actorUri: 'https://threads.net/ap/users/freshperson', transportAcct: 'freshperson@threads.net', sourceUserId: 'threads-source' },
    { canonicalAcct: 'freshperson@instagram.com', network: 'instagram.com', protocol: 'activitypub', actorUri: 'https://bridge.example/users/freshperson', transportAcct: 'freshperson@bridge.example', sourceUserId: 'instagram-source' }] };
  it('accepts the other proven network alias of one canonical person', () => {
    expect(isPublicProfileHandle('@FreshPerson@Threads.net', 'freshperson@instagram.com', profile)).toBe(true);
  });
  it('does not promote the same proven source transport acct', () => {
    expect(isPublicProfileHandle('freshperson@bridge.example', 'freshperson@instagram.com', profile)).toBe(false);
  });
  it('does not infer a link from a matching handle without Oxy proof', () => {
    expect(isPublicProfileHandle('freshperson@threads.net', 'freshperson@instagram.com', {})).toBe(false);
  });
  it('rejects malformed alias metadata rather than adopting its handle', () => {
    expect(isPublicProfileHandle('freshperson@threads.net', 'freshperson@instagram.com', { externalIdentities: [{ canonicalAcct: 'freshperson@threads.net' }] })).toBe(false);
  });
});
