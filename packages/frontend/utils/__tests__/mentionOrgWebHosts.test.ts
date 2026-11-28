/**
 * The frontend half of preparing mention.org as the canonical web host
 * (docs/mention-org-domain-move.md). Nothing here may change what a build makes
 * TODAY: with `WEB_BASE_URL` on mention.earth every link and handle is
 * byte-identical to the hard-coded value it replaced. Each one follows the
 * configuration once it is flipped.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  FEDERATION_DOMAIN,
  PUBLIC_INSTANCE_WEB_HOSTS,
  WEB_ALIAS_HOSTS,
  WEB_BASE_URL,
  parseWebAliasHosts,
} from '@/config';
import { localFederatedHandle } from '@/utils/localFederatedHandle';
import { OWN_PROFILE_HOSTS, ownProfileHostsFor } from '@/utils/ownProfileLinks';
import { postPermalink } from '@/utils/postPermalink';
import { webUrl } from '@/utils/webUrl';

describe('today (no configuration): output is unchanged', () => {
  it('is still the public instance on mention.earth', () => {
    expect(WEB_BASE_URL).toBe('https://mention.earth');
    expect(FEDERATION_DOMAIN).toBe('mention.earth');
  });

  it('builds the same links the hard-coded strings did', () => {
    expect(webUrl('')).toBe('https://mention.earth');
    expect(postPermalink('abc123')).toBe('https://mention.earth/p/abc123');
    expect(webUrl('/@alice')).toBe('https://mention.earth/@alice');
    expect(webUrl('/c/news')).toBe('https://mention.earth/c/news');
    expect(webUrl('/live-rooms/r1')).toBe('https://mention.earth/live-rooms/r1');
    expect(webUrl('/lists/l1')).toBe('https://mention.earth/lists/l1');
    expect(webUrl('/help/community-notes')).toBe('https://mention.earth/help/community-notes');
  });

  it('shows the same fediverse handle', () => {
    // What `@${username}@${new URL(WEB_BASE_URL).host}` produced.
    expect(localFederatedHandle('alice')).toBe(`@alice@${new URL(WEB_BASE_URL).host}`);
    expect(localFederatedHandle('alice')).toBe('@alice@mention.earth');
  });

  it('recognises mention.earth and mention.org links as its own', () => {
    expect(WEB_ALIAS_HOSTS).toEqual(['mention.earth', 'mention.org']);
    expect(OWN_PROFILE_HOSTS).toEqual(['mention.earth', 'mention.org']);
  });
});

describe('the share-link builders read WEB_BASE_URL, not a literal host', () => {
  // A comment may still name the host; code that builds a link may not.
  const files = [
    'utils/postPermalink.ts',
    'components/Profile/hooks/usePersonProfileView.tsx',
    'components/ChannelScreen.tsx',
    'app/(app)/live-rooms/[id].tsx',
    'app/(app)/lists/[id].tsx',
    'components/WhoToFollowTab.tsx',
    'components/Profile/ConnectionsScreen.tsx',
    'components/CommunityNotes/useCommunityNoteSheets.tsx',
    'components/settings/pages/fediverse/index.tsx',
  ];
  it.each(files)('%s', (file) => {
    const source = readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/mention\.(earth|org)/);
    expect(code).not.toMatch(/new URL\(WEB_BASE_URL\)\.host/);
  });
});

describe('web alias hosts (EXPO_PUBLIC_WEB_ALIAS_HOSTS)', () => {
  it('defaults to the public instance hosts on either of them', () => {
    expect(parseWebAliasHosts(undefined, 'https://mention.earth')).toEqual([
      ...PUBLIC_INSTANCE_WEB_HOSTS,
    ]);
    expect(parseWebAliasHosts('', 'https://mention.org/')).toEqual([...PUBLIC_INSTANCE_WEB_HOSTS]);
  });

  it('defaults to none on any other deployment, so it never claims our links', () => {
    expect(parseWebAliasHosts(undefined, 'https://social.alpha.example')).toEqual([]);
    expect(parseWebAliasHosts(undefined, 'not a url')).toEqual([]);
  });

  it('honours an explicit list and none', () => {
    expect(parseWebAliasHosts(' a.example, https://B.example/ ,,a.example', 'https://x')).toEqual([
      'a.example',
      'b.example',
    ]);
    expect(parseWebAliasHosts('none', 'https://mention.earth')).toEqual([]);
    expect(parseWebAliasHosts('NONE', 'https://mention.org')).toEqual([]);
  });

  it('own profile hosts are the web host plus the aliases, once each', () => {
    expect(ownProfileHostsFor('https://mention.org', ['mention.earth', 'mention.org'])).toEqual([
      'mention.org',
      'mention.earth',
    ]);
    expect(ownProfileHostsFor('https://social.alpha.example', [])).toEqual([
      'social.alpha.example',
    ]);
    expect(ownProfileHostsFor('not a url', ['mention.org'])).toEqual([]);
  });
});

describe('after the flip (EXPO_PUBLIC_WEB_BASE_URL=https://mention.org)', () => {
  it('builds links on mention.org and keeps the handle on mention.earth', () => {
    jest.isolateModules(() => {
      jest.doMock('@/config', () => ({
        ...jest.requireActual('@/config'),
        WEB_BASE_URL: 'https://mention.org',
      }));
      const { postPermalink: flippedPermalink } = require('@/utils/postPermalink');
      const { webUrl: flippedWebUrl } = require('@/utils/webUrl');
      const { localFederatedHandle: flippedHandle } = require('@/utils/localFederatedHandle');
      expect(flippedPermalink('abc123')).toBe('https://mention.org/p/abc123');
      expect(flippedWebUrl('/@alice')).toBe('https://mention.org/@alice');
      expect(flippedHandle('alice')).toBe('@alice@mention.earth');
    });
  });
});
