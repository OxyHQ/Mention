import { describe, expect, it, vi } from 'vitest';

/**
 * Both web hosts are OURS (docs/mention-org-domain-move.md, Phase 2 preparation).
 *
 * mention.org serves the same app as mention.earth (`MENTION_WEB_ALIAS_ORIGINS`),
 * so a pasted `https://mention.org/@alice` or `alice@mention.org` names a local
 * user: it resolves through Oxy and is never fetched as a remote instance. The
 * federation and actor domains, which every outward identifier is built from,
 * stay mention.earth.
 */

const mocks = vi.hoisted(() => ({
  isBlockedDomain: vi.fn((_host: string) => false),
  resolveOxyUser: vi.fn(),
}));

vi.mock('../connectors/activitypub/constants', () => ({
  isBlockedDomain: mocks.isBlockedDomain,
  resolveOxyUser: mocks.resolveOxyUser,
}));
vi.mock('../utils/cache', () => ({
  createCache: () => ({ getMany: async (keys: string[]) => keys.map(() => undefined) }),
}));
vi.mock('../utils/clarityClient', () => ({ getClarityClient: async () => null }));
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { config, webHostsOf } from '../config';
import { isOwnActorUri, isOwnDomain, OWN_DOMAINS } from '../connectors/activitypub/ownDomain';
import { parseLocalFollowRef } from '../connectors/localFollow';
import { resolveHrefIdentity } from '../services/posts/profileLinkMentions';
import { isOwnProfileLink, previewableUrls } from '../utils/clarityDocuments';

describe('the web hosts', () => {
  it('are the canonical origin and its aliases, canonical first', () => {
    expect(config.web.hosts).toEqual(['mention.earth', 'mention.org']);
  });

  it('follow the configuration through the flip', () => {
    expect(webHostsOf('https://mention.org', ['https://mention.earth'])).toEqual([
      'mention.org',
      'mention.earth',
    ]);
    expect(webHostsOf('https://mention.earth', [])).toEqual(['mention.earth']);
    expect(webHostsOf('https://Mention.Earth', ['https://mention.earth'])).toEqual([
      'mention.earth',
    ]);
  });
});

describe('the post-page purge zones', () => {
  it('default to the single zone purged today: the canonical host in CLOUDFLARE_ZONE_ID', () => {
    expect(config.edgePurge.zones).toEqual([
      { host: 'mention.earth', zoneId: '6c2a616f72102ee543329c87fa3b5e08' },
    ]);
  });
});

describe('OWN_DOMAINS', () => {
  it('names both web hosts, once each, and leaves the federation domain alone', () => {
    expect(config.federation.domain).toBe('mention.earth');
    expect(config.federation.actorDomain).toBe('mention.earth');
    expect(OWN_DOMAINS).toContain('mention.earth');
    expect(OWN_DOMAINS).toContain('mention.org');
    expect(new Set(OWN_DOMAINS).size).toBe(OWN_DOMAINS.length);
  });

  it('answers our hosts and nobody else', () => {
    expect(isOwnDomain('mention.org')).toBe(true);
    expect(isOwnDomain('www.mention.org')).toBe(true);
    expect(isOwnDomain('MENTION.ORG')).toBe(true);
    expect(isOwnDomain('mention.earth')).toBe(true);
    expect(isOwnDomain('notmention.org')).toBe(false);
    expect(isOwnDomain('mention.org.evil.example')).toBe(false);
    expect(isOwnActorUri('https://mention.org/ap/users/alice')).toBe(true);
  });

  it('makes alice@mention.org a local follow, not a remote one', () => {
    expect(parseLocalFollowRef('alice@mention.org')).toEqual({
      kind: 'username',
      username: 'alice',
    });
    expect(parseLocalFollowRef('@alice@mention.earth')).toEqual({
      kind: 'username',
      username: 'alice',
    });
    expect(parseLocalFollowRef('alice@mastodon.social')).toBeNull();
  });

  it('resolves a pasted mention.org profile link locally, without the remote resolver', async () => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'oxy_alice', username: 'alice' });
    const resolveRemote = vi.fn();
    await expect(resolveHrefIdentity('https://mention.org/@alice', resolveRemote)).resolves.toEqual(
      { oxyUserId: 'oxy_alice', isLocal: true },
    );
    expect(mocks.resolveOxyUser).toHaveBeenCalledWith('alice');
    expect(resolveRemote).not.toHaveBeenCalled();
  });
});

describe('own profile links (link cards)', () => {
  it('withhold the card for a profile on either web host', () => {
    expect(isOwnProfileLink('https://mention.earth/@alice')).toBe(true);
    expect(isOwnProfileLink('https://mention.org/@alice')).toBe(true);
    expect(isOwnProfileLink('https://mastodon.social/@alice')).toBe(false);
    expect(
      previewableUrls('https://mention.org/@alice https://mention.org/p/abc https://a.example'),
    ).toEqual(['https://mention.org/p/abc', 'https://a.example']);
  });
});
