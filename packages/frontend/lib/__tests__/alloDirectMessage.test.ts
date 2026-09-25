import {
  alloDirectMessageLinks,
  getAlloStoreUrl,
  openAlloDirectMessage,
  type OpenAlloDirectMessageDeps,
} from '../alloDirectMessage';

/**
 * "Message @user" opens a direct conversation in Allo (#1140). Allo's `/c/:id`
 * takes an Oxy account id and creates the direct conversation, so both links
 * carry the id; the native one uses the `allo://` scheme because no https host
 * reaches the installed app today.
 */

const UUID = '01929c4e-7b1a-7c3d-9e2f-0a1b2c3d4e5f';
const OBJECT_ID = '64b7f0c2a1e4d93f5c2b1a09';

describe('alloDirectMessageLinks', () => {
  it('builds the app and web links for a uuid account id', () => {
    expect(alloDirectMessageLinks(UUID)).toEqual({
      app: `allo://c/${UUID}`,
      web: `https://allo.you/c/${UUID}`,
    });
  });

  it('accepts the 24-hex ObjectId shape Oxy still issues for older accounts', () => {
    expect(alloDirectMessageLinks(OBJECT_ID)?.web).toBe(`https://allo.you/c/${OBJECT_ID}`);
  });

  it('trims surrounding whitespace', () => {
    expect(alloDirectMessageLinks(`  ${UUID}\n`)?.app).toBe(`allo://c/${UUID}`);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
    ['a path', '../settings'],
    ['a query', 'abc?x=1'],
    ['a fragment', 'abc#x'],
    ['an encoded slash', 'abc%2Fdef'],
    ['inner whitespace', 'abc def'],
    ['a handle with an @', '@alice'],
  ])('yields no link for %s', (_label, value) => {
    expect(alloDirectMessageLinks(value as string | null | undefined)).toBeNull();
  });
});

describe('getAlloStoreUrl', () => {
  const IOS = 'https://apps.apple.com/app/id1';
  const PLAY = 'https://play.google.com/store/apps/details?id=com.allo.app';

  it('is undefined while Allo has no store listing configured (the default config)', () => {
    expect(getAlloStoreUrl('ios')).toBeUndefined();
    expect(getAlloStoreUrl('android')).toBeUndefined();
  });

  it('picks the listing for the platform, and none on web', () => {
    const listings = { ios: IOS, android: PLAY };
    expect(getAlloStoreUrl('ios', listings)).toBe(IOS);
    expect(getAlloStoreUrl('android', listings)).toBe(PLAY);
    expect(getAlloStoreUrl('web', listings)).toBeUndefined();
  });

  it('refuses a listing that is not https', () => {
    expect(getAlloStoreUrl('android', { ios: undefined, android: 'market://details?id=com.allo.app' })).toBeUndefined();
    expect(getAlloStoreUrl('android', { ios: undefined, android: '   ' })).toBeUndefined();
    expect(getAlloStoreUrl('ios', { ios: '', android: PLAY })).toBeUndefined();
  });
});

describe('openAlloDirectMessage', () => {
  function deps(overrides: Partial<OpenAlloDirectMessageDeps> = {}) {
    return {
      platformOS: 'android',
      openAppUrl: jest.fn().mockResolvedValue(true),
      openWebUrl: jest.fn().mockResolvedValue(undefined),
      offerInstall: jest.fn(),
      ...overrides,
    } satisfies OpenAlloDirectMessageDeps;
  }

  it('opens the web app in a new tab on web, never the app scheme', async () => {
    const d = deps({ platformOS: 'web' });
    await expect(openAlloDirectMessage(UUID, d)).resolves.toBe('web');
    expect(d.openWebUrl).toHaveBeenCalledWith(`https://allo.you/c/${UUID}`);
    expect(d.openAppUrl).not.toHaveBeenCalled();
  });

  it.each(['android', 'ios'])('opens the installed app on %s', async (platformOS) => {
    const d = deps({ platformOS });
    await expect(openAlloDirectMessage(UUID, d)).resolves.toBe('app');
    expect(d.openAppUrl).toHaveBeenCalledWith(`allo://c/${UUID}`);
    expect(d.openWebUrl).not.toHaveBeenCalled();
    expect(d.offerInstall).not.toHaveBeenCalled();
  });

  it('opens the web app in the browser when Allo is not installed and there is no listing', async () => {
    const d = deps({ openAppUrl: jest.fn().mockRejectedValue(new Error('No Activity found')) });
    await expect(openAlloDirectMessage(UUID, d)).resolves.toBe('browser');
    expect(d.openWebUrl).toHaveBeenCalledWith(`https://allo.you/c/${UUID}`);
    expect(d.offerInstall).not.toHaveBeenCalled();
  });

  it('offers the store or the web app when Allo is not installed and a listing exists', async () => {
    const storeUrl = 'https://apps.apple.com/app/id1';
    const d = deps({
      platformOS: 'ios',
      storeUrl,
      openAppUrl: jest.fn().mockRejectedValue(new Error('Unable to open URL')),
    });
    await expect(openAlloDirectMessage(UUID, d)).resolves.toBe('offered');
    expect(d.offerInstall).toHaveBeenCalledWith({ storeUrl, webUrl: `https://allo.you/c/${UUID}` });
    expect(d.openWebUrl).not.toHaveBeenCalled();
  });

  it('opens nothing for an id that cannot address a conversation', async () => {
    const d = deps();
    await expect(openAlloDirectMessage('a/b', d)).resolves.toBe('invalid');
    await expect(openAlloDirectMessage(undefined, d)).resolves.toBe('invalid');
    expect(d.openAppUrl).not.toHaveBeenCalled();
    expect(d.openWebUrl).not.toHaveBeenCalled();
    expect(d.offerInstall).not.toHaveBeenCalled();
  });
});
