import { federationInfoOf } from '../federationInfo';

// `@oxy.so/core` ships ESM only. The stand-in keeps the one rule this file
// relies on: a federated username already carries its `@domain`; otherwise
// the instance is appended.
jest.mock('@oxy.so/core', () => ({
  getNormalizedUserHandle: ({ username, instance }: { username?: string; instance?: string }) =>
    username && !username.includes('@') && instance ? `${username}@${instance}` : username,
}));

/**
 * Where the About screen says a federated account lives, and where "View
 * original profile" goes. Each network is asserted, including the Instagram
 * identities that reach Mention through the kilogram bridge (an ActivityPub
 * actor URL that is NOT a web page) and through the Graph API (no URL at all).
 */
describe('federationInfoOf', () => {
  it('says nothing about a local account', () => {
    expect(federationInfoOf({ isFederated: false, username: 'alice' })).toBeNull();
    expect(federationInfoOf(undefined)).toBeNull();
  });

  it('links a fediverse account to its actor URL', () => {
    expect(
      federationInfoOf({
        isFederated: true,
        username: 'alice@mastodon.social',
        instance: 'mastodon.social',
        actorUri: 'https://mastodon.social/users/alice',
      }),
    ).toMatchObject({
      network: 'activitypub',
      instance: 'mastodon.social',
      originalProfileUrl: 'https://mastodon.social/users/alice',
    });
  });

  it.each([
    ['did:plc:abc123', 'https://bsky.app/profile/did:plc:abc123'],
    ['at://did:plc:abc123/app.bsky.feed.post/1', 'https://bsky.app/profile/did:plc:abc123'],
  ])('links a Bluesky account (%s) to bsky.app', (actorUri, url) => {
    expect(
      federationInfoOf({
        isFederated: true,
        username: 'alice@bsky.social',
        instance: 'bsky.social',
        actorUri,
      }),
    ).toMatchObject({ network: 'atproto', originalProfileUrl: url });
  });

  it('recognises Bluesky by its network domain alone', () => {
    expect(
      federationInfoOf({
        isFederated: true,
        username: 'alice@bsky.social',
        instance: 'bsky.social',
      }),
    ).toMatchObject({ network: 'atproto', originalProfileUrl: null });
  });

  it('links a kilogram-bridged Instagram account to instagram.com, never the bridge', () => {
    const info = federationInfoOf({
      isFederated: true,
      username: 'zuck@instagram.com',
      instance: 'instagram.com',
      actorUri: 'https://kilogram.makeup/users/zuck',
    });
    expect(info).toMatchObject({
      network: 'instagram-graph',
      originalProfileUrl: 'https://www.instagram.com/zuck/',
    });
  });

  it('links a Graph API Instagram account (no web actor URL) to instagram.com', () => {
    expect(
      federationInfoOf({
        isFederated: true,
        username: 'plex@instagram.com',
        actorUri: 'instagram-graph:17841408799798652',
      }),
    ).toMatchObject({
      network: 'instagram-graph',
      originalProfileUrl: 'https://www.instagram.com/plex/',
    });
  });

  it('refuses to build an Instagram link from a handle that is not an Instagram username', () => {
    expect(
      federationInfoOf({
        isFederated: true,
        username: 'bad/name@instagram.com',
        instance: 'instagram.com',
      }),
    ).toMatchObject({ network: 'instagram-graph', originalProfileUrl: null });
  });
});
