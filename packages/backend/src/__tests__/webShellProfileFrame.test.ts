import { describe, expect, it } from 'bun:test';
import {
  type ProfilePalettes,
  prerenderProfile,
  profileFrameCss,
  profilePreset,
  renderPrerenderProfile,
} from '../services/webshell/prerenderProfile';
import { deprioritizeAppBoot } from '../services/webshell/prerender';

/**
 * A profile's first frame is painted in its OWNER's colour, with their banner,
 * or not at all: a frame that changes colour at the handover is the flash it
 * exists to avoid.
 */

const palettes: ProfilePalettes = {
  'garnet-acid': {
    light: { '--background': 'rgb(255 233 235)', '--foreground': 'rgb(53 14 24)' },
    dark: { '--background': 'rgb(36 2 11)', '--foreground': 'rgb(255 233 235)' },
  },
  yellow: { light: { '--background': 'rgb(1 2 3)' }, dark: { '--background': 'rgb(3 2 1)' } },
};

const nate = {
  username: 'nate',
  name: { displayName: 'Nate' },
  verified: true,
  color: 'garnet-acid',
  avatar: '01a1236a-7bb5-79ea-b83f-cb38c5e2944f',
  createdAt: '2026-02-03T10:08:23.997Z',
  links: ['https://nateisern.com/'],
  linksMetadata: [
    {
      url: 'https://nateisern.com/',
      faviconUrl: 'https://api.clarity.surf/favicons/nateisern.com',
    },
  ],
  reputationTotal: 0,
  _count: { followers: 12, following: 113 },
};
const design = {
  banner: 'https://cloud.oxy.so/banner?variant=w1280',
  posts: 101,
  reposts: 48,
  replies: 33,
};

describe('the profile first frame', () => {
  it("names the owner's preset the way the app resolves it", () => {
    expect(profilePreset('Garnet-Acid', palettes)).toBe('garnet-acid');
    expect(profilePreset('amber', palettes)).toBe('yellow');
    expect(profilePreset('#ff0088', palettes)).toBeNull();
    expect(profilePreset('nope', palettes)).toBeNull();
  });

  it('draws the profile header the app draws, in its colour', () => {
    const page = prerenderProfile(nate, design, palettes);
    expect(page?.preset).toBe('garnet-acid');
    const html = renderPrerenderProfile(page!, '/@nate');
    expect(html).toContain('data-palette="garnet-acid"');
    expect(html).toContain('<a href="/@nate">Nate</a>');
    expect(html).toContain('aria-label="Verified"');
    expect(html).toContain('<b>113</b> Following');
    expect(html).toContain('<b>101</b> Posts');
    expect(html).toContain('<b>0</b> Reputation');
    expect(html).toContain('Joined February 2026');
    expect(html).toContain('href="https://nateisern.com/" rel="nofollow ugc noopener me"');
    // The cover at the 640 px rung, the avatar at the app's own.
    expect(html).toContain('src="https://cloud.oxy.so/banner?variant=w640"');
    expect(html).toMatch(
      /class="mp-pf-avatar" src="[^"]*01a1236a-7bb5-79ea-b83f-cb38c5e2944f[^"]*variant=thumb"/,
    );
  });

  it('paints the preset in light, and in dark where the document is dark', () => {
    const css = profileFrameCss(palettes['garnet-acid']);
    expect(css).toContain(
      '#mention-prerender{--background:rgb(255 233 235);--foreground:rgb(53 14 24)}',
    );
    expect(css).toContain(
      ':root[data-bloom-theme-mode="dark"] #mention-prerender{--background:rgb(36 2 11);--foreground:rgb(255 233 235)}',
    );
    expect(css).toContain(
      '@media (prefers-color-scheme:dark){:root:not([data-bloom-theme-mode="light"])',
    );
  });

  it('draws no frame it could not colour the way the app does', () => {
    expect(prerenderProfile({ ...nate, color: '#ff0088' }, design, palettes)).toBeNull();
    expect(prerenderProfile(nate, design, undefined)).toBeNull();
    // No colour: the reader's own theme, as the app draws it.
    expect(
      prerenderProfile({ ...nate, color: undefined }, design, palettes)?.preset,
    ).toBeUndefined();
  });

  it('never lets a palette value escape its declaration', () => {
    const css = profileFrameCss({
      light: { '--background': 'red}body{display:none', '--ok': 'rgb(1 2 3)' },
      dark: {},
    });
    expect(css).not.toContain('display:none');
    expect(css).toContain('--ok:rgb(1 2 3)');
  });

  it("puts the cover ahead of the app's boot downloads", () => {
    const doc =
      '<link rel="preload" href="/x.woff2" as="font" data-first-paint-font><link rel="preload" href="/_expo/static/js/web/_layout-a.js" as="script" data-route-layout><script src="/_expo/static/js/web/entry-a.js" defer></script><script src="/oxy-sw-register.js" defer></script>';
    const out = deprioritizeAppBoot(doc);
    expect(out).toContain('<link fetchpriority="low" rel="preload" href="/x.woff2"');
    expect(out).toContain(
      '<script fetchpriority="low" src="/_expo/static/js/web/entry-a.js" defer>',
    );
    expect(out).toContain('<script src="/oxy-sw-register.js" defer>');
    expect(deprioritizeAppBoot(out)).toBe(out);
  });
});
