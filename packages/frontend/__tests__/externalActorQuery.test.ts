import { looksLikeRemoteHandle } from '../utils/externalActor';

/**
 * Which search queries are worth asking `GET /federation/resolve` about.
 *
 * A pasted profile link is one of them, and it did not used to be: none of the
 * handle shapes match a URL, so pasting `https://x.com/elonmusk` never fired a
 * resolve and the search could only ever find that account if something else had
 * already pulled it in.
 *
 * The bar for this classifier is asymmetric on purpose. Firing on a URL the
 * backend cannot resolve costs one request that answers 404 — which the hook
 * already treats as the same quiet `null` as any other miss. NOT firing loses the
 * link silently, and looks identical to "we do not have that account", so it is
 * the failure nobody reports. Hence: every absolute http(s) link with a path, and
 * no attempt to second-guess which hosts the backend covers.
 */

describe('looksLikeRemoteHandle — pasted profile links', () => {
  it.each([
    'https://x.com/elonmusk',
    'https://twitter.com/elonmusk?s=20',
    'https://www.instagram.com/plex/',
    'https://bsky.app/profile/georgemonbiot.bsky.social',
    // Hosts the backend does not resolve today still ask: the host list is the
    // backend's, and a copy of it here is a copy that can go stale.
    'https://mastodon.social/@Gargron',
    'http://example.com/someone',
  ])('asks about %s', (query) => {
    expect(looksLikeRemoteHandle(query)).toBe(true);
  });

  it.each([
    ['a bare host with no account on it', 'https://x.com'],
    ['a bare host with a trailing slash', 'https://x.com/'],
    ['a non-http scheme', 'javascript:alert(1)'],
  ])('does not ask about %s', (_label, query) => {
    expect(looksLikeRemoteHandle(query)).toBe(false);
  });
});

describe('looksLikeRemoteHandle — the shapes it already recognised', () => {
  it.each([
    '@alice@mastodon.social',
    'alice@mastodon.social',
    'alice.bsky.social',
    'did:plc:ewvi7nxzyoun6zhxrhs64oiz',
    'at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/app.bsky.feed.post/3k',
  ])('still asks about %s', (query) => {
    expect(looksLikeRemoteHandle(query)).toBe(true);
  });

  it.each([['a local username', '@nate'], ['a bare word', 'nate'], ['nothing', '   ']])(
    'still stays on the local people search for %s',
    (_label, query) => {
      expect(looksLikeRemoteHandle(query)).toBe(false);
    },
  );
});
