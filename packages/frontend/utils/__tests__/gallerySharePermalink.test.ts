import { profileRouteFamily } from '@/components/Profile/profileRoute';
import { WEB_BASE_URL } from '@/config';
import { isPublicProfileHandle } from '@/utils/publicProfileHandle';
import { galleryPostPermalink, galleryProfilePermalink } from '../gallerySharePermalink';
import { postPermalink } from '../postPermalink';

const origin = WEB_BASE_URL.replace(/\/$/, '');

describe('gallery share permalinks', () => {
  it.each([
    ['alice', { kind: 'personal' as const }, '/@alice'],
    ['news', { kind: 'channel' as const }, '/c/news'],
    ['alice@remote.example', { isFederated: true }, '/@alice%40remote.example'],
    [
      'news@remote.example',
      { kind: 'channel' as const, isFederated: true },
      '/@news%40remote.example',
    ],
  ])('uses the resolved account family for %s', (username, account, path) => {
    const result = galleryProfilePermalink(username, profileRouteFamily(account));
    expect(result).toBe(`${origin}${path}`);
    if (!result) throw new Error('Expected a profile permalink');
    expect(decodeURIComponent(new URL(result).pathname)).toBe(decodeURIComponent(path));
  });

  it('shares the validated Oxy identity rather than a bridge transport account', () => {
    const username = 'freshperson@instagram.com';
    const transport = 'freshperson@bridge.example';
    const account = { isFederated: true };
    expect(isPublicProfileHandle(transport, username)).toBe(false);
    expect(galleryProfilePermalink(username, profileRouteFamily(account))).toBe(
      `${origin}/@freshperson%40instagram.com`,
    );
  });

  it.each([undefined, null, '', 'alice/path', 'alice?token=secret', '\ud800'])(
    'does not invent a link without a routeable canonical username: %p',
    (username) => expect(galleryProfilePermalink(username, 'person')).toBeUndefined(),
  );

  it('shares the existing post permalink and encodes the id as one path component', () => {
    expect(galleryPostPermalink('post-1')).toBe(postPermalink('post-1'));
    expect(galleryPostPermalink('post/id?private')).toBe(postPermalink('post%2Fid%3Fprivate'));
    expect(galleryPostPermalink('  ')).toBeUndefined();
    expect(galleryPostPermalink('\ud800')).toBeUndefined();
  });
});
