import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';
import {
  mirroredNetworkDomain,
  networkUrlOf,
  rewriteMirrorUrls,
} from '../../utils/federation/mirrorTransports';

describe('mirror transports', () => {
  it('maps a mirror URL to the network it republishes', () => {
    expect(networkUrlOf('https://bird.makeup/users/elonmusk')).toBe('https://x.com/elonmusk');
    expect(networkUrlOf('https://bird.makeup/users/a/statuses/123')).toBe(
      'https://x.com/a/status/123',
    );
    expect(networkUrlOf('https://mastox.eu/@wired')).toBe('https://x.com/wired');
    expect(networkUrlOf('https://kilogram.makeup/users/zuck/statuses/Dc1')).toBe(
      'https://instagram.com/p/Dc1',
    );
  });

  it('leaves what has no upstream form, and every other host, alone', () => {
    expect(networkUrlOf('https://mastox.eu/@wired/117178258152054736')).toBeUndefined();
    expect(networkUrlOf('https://bird.makeup/about')).toBeUndefined();
    expect(networkUrlOf('https://mastodon.social/@alice')).toBeUndefined();
    expect(mirroredNetworkDomain('mastodon.social')).toBeUndefined();
    expect(mirroredNetworkDomain('bird.makeup')).toBe('x.com');
  });

  it('rewrites mirror URLs and stored mention links in a body, prose untouched', () => {
    expect(
      rewriteMirrorUrls(
        'thanks [@@elonmusk@bird.makeup](https://bird.makeup/users/elonmusk)! see https://bird.makeup/users/a/statuses/1. ok https://example.org',
      ),
    ).toBe(
      'thanks [@@elonmusk@x.com](https://x.com/elonmusk)! see https://x.com/a/status/1. ok https://example.org',
    );
  });

  it('shows a mirror mention as the account on the real network', () => {
    const html =
      '<span class="h-card"><a href="https://bird.makeup/users/elonmusk" class="u-url mention">@<span>elonmusk</span></a></span>';
    expect(htmlToPlainText(html, { preserveMentionLinks: true })).toBe(
      '[@@elonmusk@x.com](https://x.com/elonmusk)',
    );
  });
});
