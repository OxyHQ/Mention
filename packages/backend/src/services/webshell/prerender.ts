/**
 * The first frame of a public post page, server-rendered.
 *
 * WHY: the document's body was `<div id="root"></div>` and nothing else, for
 * every reader and every crawler, until the 1.5 MB common chunk had run —
 * Lighthouse's mobile profile measured FCP ~12 s and LCP ~16 s on a post
 * (2026-11-28), and a crawler that does not run the app saw no post at all.
 *
 * WHAT: a readable page — the post's author (linked), its words (with their
 * links), its media (with alt text and their box reserved), its time and
 * counts — in the initial HTML, laid
 * out like the app's own mobile screen and painted with the theme the document
 * already chose (`--background`, `--foreground`, … from the theme prepaint).
 *
 * Posts only, for now. A profile is painted in its OWNER's colour, with their
 * banner, neither of which the document knows before the app runs; a frame in
 * the reader's colour would change colour under them at the handover.
 *
 * HOW IT HANDS OVER (no flash): it is a fixed layer OVER `#root`, not inside it,
 * because React's first commit clears whatever the container holds and the app
 * first draws its loading states. The app keeps booting underneath, untouched.
 * When the route has committed the same content (`<SEO ready>`), the app
 * removes the layer (`frontend/lib/prerender.ts`) with a short fade. A reader
 * without JavaScript keeps the layer: it scrolls, and every link is a real
 * `<a href>`.
 *
 * WHAT IT NEVER SHOWS: only a page the web shell already decided to render for
 * anyone (public, published, visible author, not gated by a content warning) is
 * prerendered — the same verdicts the head metadata uses, from the same
 * request. A gated post, an unavailable or private one, gets no layer at all.
 * Nothing here is viewer-relative: the document is publicly cached.
 */
import type { HydratedPost } from '@mention/shared-types';
import { toReaderText } from '@mention/shared-types/textEntities';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { resolveMediaRef } from '../../utils/mediaResolver';
import { canonicalProfilePath, escapeHtml } from './webShellRenderer';

/** The element the app removes once its own route has committed. */
export const PRERENDER_ELEMENT_ID = 'mention-prerender';

/** What a post's first frame shows. Plain data, cached with the page's card. */
export interface PrerenderPost {
  author: { name: string; handle: string | null; profilePath: string | null; avatar?: string };
  text: string;
  lang?: string;
  media: { url: string; alt?: string; width?: number; height?: number; video?: boolean }[];
  createdAt?: string;
  counts: { likes?: number; reposts?: number; quotes?: number; saves?: number };
}

const AVATAR_VARIANT = 'w96';

/** An avatar reference as an image URL on one of our origins, at `variant`. */
export function avatarUrl(avatar: unknown, variant = AVATAR_VARIANT): string | undefined {
  if (typeof avatar !== 'string' || !avatar) return undefined;
  const resolved = resolveMediaRef(avatar);
  const url = resolved.thumbUrl ?? resolved.url;
  if (!url) return undefined;
  // An Oxy file id resolves to the CDN; ask for the avatar rung.
  return url.includes('variant=') ? url.replace(/variant=[^&]+/, `variant=${variant}`) : url;
}

/** The first frame's data for a post, from the hydrated post the card is built from. */
export function prerenderPost(post: HydratedPost): PrerenderPost {
  const user = post.user;
  const handle = getNormalizedUserHandle(user);
  const original = post.originalPost?.content;
  const text = toReaderText(post.content?.text?.trim() || original?.text || '').trim();
  const media = (post.content?.media?.length ? post.content.media : original?.media) ?? [];
  const engagement = post.engagement;
  const count = (value: number | null | undefined) =>
    typeof value === 'number' && value >= 0 ? value : undefined;
  return {
    author: {
      name: user.name?.displayName?.trim() || (handle ? `@${handle}` : 'Someone'),
      handle,
      profilePath: handle
        ? canonicalProfilePath({ username: handle, kind: user.kind, isFederated: user.isFederated })
        : null,
      avatar: avatarUrl(user.avatar),
    },
    text,
    lang: post.content?.textLang || post.metadata?.language || undefined,
    media: media.flatMap((item) => {
      // The same URL the app's card requests (`thumbUrl`, a GIF's original),
      // so the card's own image is already in the cache when it mounts.
      const url =
        item.type === 'video'
          ? item.posterUrl || item.thumbUrl
          : item.type === 'gif'
            ? item.url || item.thumbUrl
            : item.thumbUrl || item.url;
      if (!url) return [];
      return [
        {
          url,
          ...(item.alt?.trim() ? { alt: item.alt.trim() } : {}),
          ...(item.width && item.height ? { width: item.width, height: item.height } : {}),
          ...(item.type === 'video' ? { video: true } : {}),
        },
      ];
    }),
    createdAt: post.metadata?.createdAt,
    counts: {
      likes: count(engagement?.likes),
      reposts: count(engagement?.reposts),
      quotes: count(engagement?.quotes),
      saves: count(engagement?.saves),
    },
  };
}

const URL_OR_TAG_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?"')\]]|#[\p{L}\p{N}_]+)/gu;

/** Reader text as HTML: escaped, with its links and hashtags as real anchors. */
export function richText(text: string): string {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(URL_OR_TAG_RE)) {
    const token = match[0];
    const at = match.index ?? 0;
    html += escapeHtml(text.slice(last, at));
    if (token.startsWith('#')) {
      const tag = token.slice(1).toLowerCase();
      html += `<a href="/hashtag/${encodeURIComponent(tag)}">${escapeHtml(token)}</a>`;
    } else {
      // Someone else's link: followed by people, not vouched for by Mention.
      html += `<a href="${escapeHtml(token)}" rel="nofollow ugc noopener" target="_blank">${escapeHtml(token)}</a>`;
    }
    last = at + token.length;
  }
  html += escapeHtml(text.slice(last));
  // The app draws `**bold**` as bold; so does the frame, or its words reflow
  // at the handover.
  return html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
}

const TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});
const DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** The app's own form, `11:04 AM · Nov 21, 2026` (in UTC: the server knows no reader's zone). */
function postTime(iso: string): string {
  const date = new Date(iso);
  return `${TIME_FORMAT.format(date)} · ${DAY_FORMAT.format(date)}`;
}

export function countLabel(value: number | undefined, one: string, many: string): string {
  if (value === undefined) return '';
  return `<span><b>${value}</b> ${value === 1 ? one : many}</span>`;
}

function avatarHtml(src: string | undefined, size: number): string {
  return src
    ? `<img class="mp-avatar" src="${escapeHtml(src)}" width="${size}" height="${size}" alt="" decoding="async">`
    : `<span class="mp-avatar" style="width:${size}px;height:${size}px"></span>`;
}

/** The post's first frame. */
export function renderPrerenderPost(page: PrerenderPost, postPath: string): string {
  const { author } = page;
  const authorLink = (inner: string) =>
    author.profilePath ? `<a href="${escapeHtml(author.profilePath)}">${inner}</a>` : inner;
  const media = page.media
    .map((item, index) => {
      const ratio = item.width && item.height ? item.width / item.height : 4 / 3;
      // The app clamps a single image between 4:5 and 2:1; reserve that box.
      const boxed = Math.min(Math.max(ratio, 4 / 5), 2);
      const alt = item.alt ?? (item.video ? `Video by ${author.name}` : `Image by ${author.name}`);
      return `<img class="mp-media${page.media.length > 1 ? ' mp-media-multi' : ''}" src="${escapeHtml(item.url)}" alt="${escapeHtml(alt)}"${index === 0 ? ' fetchpriority="high" loading="eager"' : ' loading="lazy"'} decoding="async" style="aspect-ratio:${boxed.toFixed(4)}">`;
    })
    .join('');
  const time = page.createdAt
    ? `<time datetime="${escapeHtml(page.createdAt)}">${escapeHtml(postTime(page.createdAt))}</time>`
    : '';
  const counts = [
    countLabel(page.counts.likes, 'like', 'likes'),
    countLabel(page.counts.reposts, 'repost', 'reposts'),
    // Quotes are counted on read (an extra statement per page), so the card's
    // hydration leaves them out; the app adds them to this row.
    countLabel(page.counts.quotes, 'quote', 'quotes'),
    countLabel(page.counts.saves, 'save', 'saves'),
  ].join('');
  return (
    `<div id="${PRERENDER_ELEMENT_ID}" data-mention-prerender>` +
    `<header class="mp-bar"><a class="mp-back" href="/" aria-label="Mention">&#8592;</a><h2>Post</h2></header>` +
    `<main class="mp-main"><article class="mp-post"${page.lang ? ` lang="${escapeHtml(page.lang)}"` : ''}>` +
    `<div class="mp-author">${authorLink(avatarHtml(author.avatar, 36))}<div class="mp-who">` +
    `<h1 class="mp-name">${authorLink(escapeHtml(author.name))}</h1>` +
    (author.handle ? `<div class="mp-handle">@${escapeHtml(author.handle)}</div>` : '') +
    `</div></div>` +
    (page.text ? `<p class="mp-text">${richText(page.text)}</p>` : '') +
    (media ? `<div class="mp-gallery">${media}</div>` : '') +
    // The app's like/reply/repost row: its space, so nothing below moves.
    `<div class="mp-actions" aria-hidden="true"></div>` +
    `<p class="mp-meta"><a href="${escapeHtml(postPath)}">${time || 'Post'}</a></p>` +
    (counts ? `<p class="mp-counts">${counts}</p>` : '') +
    `</article></main></div>`
  );
}

/**
 * The layer's style: the app's mobile post screen, measured on the live app at
 * 412 px (2026-11-28) — a 60 px bar, a 12 px gutter, a 36 px avatar, the name at
 * 15/17 bold, the body at 17/22, the media box with a 12 px radius, the action
 * row, the time and counts rows between hairlines — painted in the document's
 * theme tokens. Inline (`style-src` allows it), so it costs no request.
 *
 * The background is the app's screen surface as it is SEEN (sampled from the
 * live app: a card-coloured surface over the page background, ~85/15 in both
 * the light and the dark palette), not `--background` alone.
 *
 * `font` is the app's Inter when the document preloads it (`fontFaceCss`), with
 * `font-display: optional`: a font that arrives late is not swapped in under a
 * reader's eyes (a swap would shift the layer's text).
 */
export function prerenderStyle(fontUrl?: string, extra = ''): string {
  const L = `#${PRERENDER_ELEMENT_ID}`;
  const face = fontUrl
    ? `@font-face{font-family:"Mention Prerender";src:url("${escapeHtml(fontUrl)}") format("woff2");font-weight:100 900;font-display:optional}`
    : '';
  return (
    `<style id="${PRERENDER_ELEMENT_ID}-style">${face}` +
    `${L}{position:fixed;inset:0;z-index:2147483000;overflow-y:auto;background:var(--card,#fff);background:color-mix(in srgb,var(--card) 85%,var(--background));color:var(--foreground,#111);font:15px/20px ${fontUrl ? '"Mention Prerender",' : ''}-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;transition:opacity .16s ease-out;-webkit-text-size-adjust:100%}` +
    `${L}.mp-leaving{opacity:0;pointer-events:none}` +
    `${L} a{color:inherit;text-decoration:none}` +
    `${L} .mp-text a{color:var(--primary-text,#06c)}` +
    `${L} .mp-bar{display:flex;align-items:center;gap:14px;height:60px;padding:0 10px;max-width:600px;margin:0 auto;box-sizing:border-box}` +
    `${L} .mp-bar h2{margin:0;font-size:16px;line-height:22px;font-weight:500}` +
    `${L} .mp-back{display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:50%;background:var(--surface,#eee);font-size:20px}` +
    `${L} .mp-main{max-width:600px;margin:0 auto;padding:0 12px 48px;box-sizing:border-box}` +
    `${L} .mp-author{display:flex;align-items:flex-start;gap:12px;padding-top:12px;min-height:36px}` +
    `${L} .mp-avatar{display:block;border-radius:50%;object-fit:cover;background:var(--muted,#ddd);flex:none}` +
    `${L} .mp-name{margin:0;font-size:15px;line-height:17px;font-weight:700}` +
    `${L} .mp-handle{color:var(--muted-foreground,#666);font-size:15px;line-height:18.75px}` +
    `${L} .mp-text{margin:12px 0 0;font-size:17px;line-height:22px;white-space:pre-wrap;overflow-wrap:anywhere}` +
    `${L} .mp-gallery{display:flex;gap:4px;margin-top:12px}` +
    `${L} .mp-media{display:block;width:100%;min-width:0;flex:1;object-fit:cover;border-radius:12px;background:var(--muted,#ddd)}` +
    `${L} .mp-media-multi{aspect-ratio:1!important}` +
    `${L} .mp-actions{height:20px;margin:14px 0}` +
    `${L} .mp-meta,${L} .mp-counts{margin:0;padding:12px 0;border-top:1px solid var(--border,#ccc);color:var(--muted-foreground,#666);font-size:14px;line-height:16px}` +
    `${L} .mp-counts{display:flex;gap:16px;border-bottom:1px solid var(--border,#ccc)}` +
    `${L} .mp-counts b{color:var(--foreground,#111);font-weight:600}` +
    // Wide screens: the app's centre column sits ~49 px left of the page's
    // centre (its navigation rail is wider than its trends rail), measured at
    // 1440 px. The rails themselves appear with the app.
    `@media (min-width:1280px){${L} .mp-bar,${L} .mp-main{max-width:620px;margin-left:calc(50% - 359px)}${L} .mp-bar{height:68px}}` +
    extra +
    `</style>`
  );
}

/** The Inter file the document preloads for its first paint (`web-font-preload.mjs`), if any. */
export function firstPaintFontUrl(shell: string): string | undefined {
  const match = /<link\b[^>]*\bhref="(\/[^"]+\.woff2)"[^>]*\bdata-first-paint-font\b/.exec(shell);
  return match?.[1];
}

/**
 * Whether this shell's release removes the layer (`frontend/public/index.html`
 * carries the marker). The frontend and the backend deploy separately; a layer
 * over a release that cannot remove it would cover the app for good.
 */
export function shellRemovesFirstFrame(shell: string): boolean {
  return /<meta name="mention-first-frame" content="1"/.test(shell);
}

/** Insert the layer as the body's first child, ahead of `#root`. */
export function injectPrerender(html: string, layer: string): string {
  if (!layer) return html;
  const body = /<body\b[^>]*>/i;
  return body.test(html) ? html.replace(body, (tag) => `${tag}${layer}`) : html;
}

/** The post's path on Mention, as the layer links it. */
export function postPath(id: string): string {
  return `/p/${encodeURIComponent(id)}`;
}

/**
 * The app's boot downloads after the frame's own image: `fetchpriority="low"`
 * on the startup scripts, the route-layout preloads and the font preload. Used
 * for a profile, whose frame paints a ~65 KB cover that otherwise shares a slow
 * connection with the 1.5 MB app bundle (measured LCP 2.67–3.0 s → 2.36–2.64 s,
 * Slow 4G applied). The reader is already looking at the page; the app still
 * boots as soon as its bytes arrive.
 */
export function deprioritizeAppBoot(html: string): string {
  return html
    .replace(
      /<script\b(?![^>]*\bfetchpriority=)([^>]*\bsrc="\/_expo\/static\/js\/[^"]+"[^>]*)>/g,
      '<script fetchpriority="low"$1>',
    )
    .replace(
      /<link\b(?![^>]*\bfetchpriority=)([^>]*\b(?:data-route-layout|data-first-paint-font)\b[^>]*)>/g,
      '<link fetchpriority="low"$1>',
    );
}
