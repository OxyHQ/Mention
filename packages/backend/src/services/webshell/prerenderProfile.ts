/**
 * The first frame of a public profile page (see `prerender.ts` for the post's,
 * and for how the app hands over from it).
 *
 * A profile is painted in its OWNER's colour, with their banner. The frame is
 * painted the same way, or the handover would change colour under the reader:
 * - the colour is the owner's `color` as the app resolves it (`resolveProfileColor`:
 *   a named Bloom preset), painted with that preset's light and dark tokens from
 *   the release's own `profile-palettes.json` (written at build time by
 *   `frontend/scripts/web-theme-prepaint.mjs` from Bloom's prepaint palettes);
 * - the banner is the profile design's `profileHeaderImage`, at the URL the app
 *   requests, cropped the way the app's cover crops it.
 * A profile whose colour is a free seed (`#rrggbb`, computed by Bloom's colour
 * engine at run time) or whose palette the release does not list gets no frame.
 *
 * Layout: the app's mobile profile, measured on the live app at 412 px
 * (2026-11-28) — a 170 px cover (a 309 px box centred in it), an 82 px avatar at
 * (20, 129), the name at 24 px bold at y 235, the handle, two rows of counts,
 * the link chips, the join date, the tab strip at y 436.
 */
import { escapeHtml } from './webShellRenderer';
import { PRERENDER_ELEMENT_ID, avatarUrl, richText } from './prerender';

/** One preset's tokens, per mode: what the frame paints with. */
export type PaletteTokens = Record<string, string>;
export interface ProfilePalette {
  light: PaletteTokens;
  dark: PaletteTokens;
}
export type ProfilePalettes = Record<string, ProfilePalette>;

/** What a profile's first frame shows. Public profile data only. */
export interface PrerenderProfile {
  name: string;
  handle: string;
  verified: boolean;
  avatar?: string;
  banner?: string;
  bio: string;
  counts: {
    following?: number;
    followers?: number;
    posts?: number;
    reposts?: number;
    replies?: number;
    reputation?: number;
  };
  links: { url: string; title: string; favicon?: string }[];
  joined?: string;
  /** The Bloom preset the profile is painted in, or none (the reader's theme). */
  preset?: string;
}

/** The Oxy profile fields the frame reads. */
export interface ProfileFrameSource {
  username?: string;
  name?: { displayName?: string };
  avatar?: string | null;
  bio?: string;
  description?: string;
  verified?: boolean;
  color?: string;
  createdAt?: string;
  links?: string[];
  linksMetadata?: { url?: string; title?: string; faviconUrl?: string }[];
  reputationTotal?: number;
  _count?: { followers?: number; following?: number };
}

/**
 * The preset `resolveProfileColor` (Bloom) names for a stored colour, when it
 * is a named preset: lowercased, `amber` read as `yellow`. A seed or anything
 * unknown is no preset.
 */
export function profilePreset(color: string | undefined, palettes: ProfilePalettes): string | null {
  if (!color) return null;
  const normalized = color.trim().toLowerCase();
  const name = normalized === 'amber' ? 'yellow' : normalized;
  return Object.hasOwn(palettes, name) ? name : null;
}

const JOINED_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** The frame's data for a profile, or null when the frame could not match the app. */
export function prerenderProfile(
  profile: ProfileFrameSource,
  design: { banner?: string; posts?: number; reposts?: number; replies?: number },
  palettes: ProfilePalettes | undefined,
): PrerenderProfile | null {
  if (!profile.username) return null;
  // A colour the release cannot paint: no frame, rather than the wrong colour.
  let preset: string | undefined;
  if (profile.color) {
    const named = palettes ? profilePreset(profile.color, palettes) : null;
    if (!named) return null;
    preset = named;
  }
  const metadata = new Map(
    (profile.linksMetadata ?? []).flatMap((entry) => (entry.url ? [[entry.url, entry]] : [])),
  );
  return {
    name: profile.name?.displayName?.trim() || `@${profile.username}`,
    handle: profile.username,
    verified: Boolean(profile.verified),
    avatar: avatarUrl(profile.avatar, 'thumb'),
    // The frame's cover at the 640 px rung: on a phone's first paint it is the
    // page's LCP, and the app's 1280 px rendition (2.5x the bytes) arrives
    // behind it — the handover waits for it (`frontend/lib/prerender.ts`).
    banner: design.banner?.includes('variant=')
      ? design.banner.replace(/variant=[^&]+/, 'variant=w640')
      : design.banner,
    bio: (profile.bio || profile.description || '').trim(),
    counts: {
      following: profile._count?.following,
      followers: profile._count?.followers,
      posts: design.posts,
      reposts: design.reposts,
      replies: design.replies,
      reputation: profile.reputationTotal,
    },
    links: (profile.links ?? [])
      .filter((url) => /^https?:\/\//i.test(url))
      .map((url) => {
        const meta = metadata.get(url);
        return {
          url,
          // The app's pill label: the owner's title, else the bare address
          // (`frontend/utils/prettifyUrl.ts`, the same two replacements).
          title: meta?.title?.trim() || url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''),
          ...(meta?.faviconUrl && /^https:\/\//.test(meta.faviconUrl)
            ? { favicon: meta.faviconUrl }
            : {}),
        };
      }),
    joined: profile.createdAt,
    ...(preset ? { preset } : {}),
  };
}

function stat(value: number | undefined, label: string): string {
  return typeof value === 'number' && value >= 0
    ? `<span class="mp-stat"><b>${value}</b> ${label}</span>`
    : '';
}

const VERIFIED_BADGE =
  '<svg class="mp-verified" viewBox="0 0 24 24" width="24" height="24" aria-label="Verified"><path fill="#1d9bf0" d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91C2.63 9.33 1.75 10.57 1.75 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z"/></svg>';

/** The tabs the app's strip shows, in its order. */
const TABS = ['Posts', 'Replies', 'Videos', 'Media', 'Reposts', 'Mentions', 'Feeds'];

/** The profile's first frame. */
export function renderPrerenderProfile(page: PrerenderProfile, profilePath: string): string {
  const cover = page.banner
    ? `<div class="mp-cover"><img src="${escapeHtml(page.banner)}" alt="" fetchpriority="high" loading="eager" decoding="async"></div>`
    : '<div class="mp-cover mp-cover-empty"></div>';
  const avatar = page.avatar
    ? `<img class="mp-pf-avatar" src="${escapeHtml(page.avatar)}" width="82" height="82" alt="">`
    : '<span class="mp-pf-avatar"></span>';
  const links = page.links
    .map(
      (link) =>
        `<a class="mp-chip" href="${escapeHtml(link.url)}" rel="nofollow ugc noopener me" target="_blank">` +
        (link.favicon
          ? `<img src="${escapeHtml(link.favicon)}" width="16" height="16" alt="">`
          : '') +
        `${escapeHtml(link.title)} &#8599;</a>`,
    )
    .join('');
  const joined = page.joined
    ? `<p class="mp-joined">Joined ${escapeHtml(JOINED_FORMAT.format(new Date(page.joined)))}</p>`
    : '';
  return (
    `<div id="${PRERENDER_ELEMENT_ID}" data-mention-prerender${page.preset ? ` data-palette="${escapeHtml(page.preset)}"` : ''}>` +
    `<header class="mp-pf-bar"><a class="mp-pf-back" href="/" aria-label="Mention">&#8592;</a></header>` +
    `<main class="mp-pf"><section class="mp-pf-hero">${cover}${avatar}</section>` +
    `<div class="mp-pf-body">` +
    `<h1 class="mp-pf-name"><a href="${escapeHtml(profilePath)}">${escapeHtml(page.name)}</a>${page.verified ? VERIFIED_BADGE : ''}</h1>` +
    `<div class="mp-pf-handle">@${escapeHtml(page.handle)}</div>` +
    (page.bio ? `<p class="mp-pf-bio">${richText(page.bio)}</p>` : '') +
    `<p class="mp-stats">${stat(page.counts.following, 'Following')}${stat(page.counts.followers, 'Followers')}${stat(page.counts.posts, 'Posts')}${stat(page.counts.reposts, 'Reposts')}</p>` +
    `<p class="mp-stats">${stat(page.counts.replies, 'Replies')}${stat(page.counts.reputation, 'Reputation')}</p>` +
    (links ? `<div class="mp-chips">${links}</div>` : '') +
    joined +
    `</div>` +
    `<nav class="mp-tabs" aria-label="Profile">${TABS.map((tab, index) => `<span${index === 0 ? ' class="mp-tab-on"' : ''}>${tab}</span>`).join('')}</nav>` +
    `</main></div>`
  );
}

/** The tokens of one mode as CSS declarations, for the frame's own scope. */
function declarations(tokens: PaletteTokens): string {
  return Object.entries(tokens)
    .filter(([name, value]) => /^--[a-z0-9-]+$/.test(name) && /^[a-z0-9 (),.%#-]+$/i.test(value))
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
}

/**
 * The profile frame's style: its layout, and — for a profile with a preset —
 * that preset's tokens on the frame itself, light by default, dark where the
 * document is dark (the prepaint's `data-bloom-theme-mode`, or the OS when no
 * script ran).
 */
export function profileFrameCss(palette: ProfilePalette | undefined): string {
  const L = `#${PRERENDER_ELEMENT_ID}`;
  const tokens = palette
    ? `${L}{${declarations(palette.light)}}` +
      `@media (prefers-color-scheme:dark){:root:not([data-bloom-theme-mode="light"]) ${L}{${declarations(palette.dark)}}}` +
      `:root[data-bloom-theme-mode="dark"] ${L}{${declarations(palette.dark)}}`
    : '';
  return (
    tokens +
    `${L} .mp-pf-bar{position:absolute;top:0;left:0;right:0;height:60px;padding:10px;box-sizing:border-box;z-index:1}` +
    `${L} .mp-pf-back{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;background:var(--card,#fff);opacity:.85;font-size:20px}` +
    `${L} .mp-pf{max-width:600px;margin:0 auto}` +
    `${L} .mp-pf-hero{position:relative;height:211px}` +
    `${L} .mp-cover{position:relative;height:170px;overflow:hidden;background:var(--muted,#ddd)}` +
    `${L} .mp-cover img{position:absolute;left:0;top:-69.5px;width:100%;height:309px;object-fit:cover}` +
    `${L} .mp-pf-avatar{position:absolute;left:20px;top:129px;display:block;width:82px;height:82px;border-radius:50%;object-fit:cover;background:var(--muted,#ddd);box-shadow:0 0 0 4px var(--card,#fff)}` +
    `${L} .mp-pf-body{padding:24px 16px 0}` +
    `${L} .mp-pf-name{display:flex;align-items:center;gap:4px;margin:0;font-size:24px;line-height:28px;font-weight:700}` +
    `${L} .mp-verified{flex:none}` +
    `${L} .mp-pf-handle{margin-top:4px;color:var(--muted-foreground,#666);font-size:15px;line-height:20px}` +
    `${L} .mp-pf-bio{margin:8px 0 0;font-size:15px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}` +
    `${L} .mp-stats{display:flex;flex-wrap:wrap;gap:0 11px;margin:12px 0 0;font-size:15px;line-height:17px;color:var(--muted-foreground,#666)}` +
    `${L} .mp-stats+.mp-stats{margin-top:10px}` +
    `${L} .mp-stats b{color:var(--foreground,#111);font-weight:700;margin-right:1px}` +
    `${L} .mp-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}` +
    `${L} .mp-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px 0 6px;border-radius:12px;background:var(--muted,#eee);color:var(--muted-foreground,#666);font-size:14px;line-height:20px;font-weight:500}` +
    `${L} .mp-chip img{border-radius:50%}` +
    `${L} .mp-joined{margin:14px 0 0;color:var(--muted-foreground,#666);font-size:15px;line-height:17px}` +
    `${L} .mp-tabs{display:flex;gap:24px;margin-top:28px;padding:8px 10px 0;height:37px;box-sizing:border-box;border-bottom:1px solid var(--border,#ccc);overflow:hidden;white-space:nowrap;font-size:14px;line-height:20px}` +
    `${L} .mp-tab-on{color:var(--primary-text,#06c);font-weight:500;box-shadow:inset 0 -2px 0 var(--primary-text,#06c)}`
  );
}
