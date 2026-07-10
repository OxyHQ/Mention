/**
 * Web-shell OpenGraph renderer — the `bskyweb` model, ported from the retired
 * Cloudflare Pages `_worker.js`.
 *
 * These are the PURE, dependency-light building blocks: they map already-fetched
 * profile / post data into an {@link OgData} record, render the OG/Twitter
 * `<meta>` block, and splice it into a static SPA shell (replacing `<title>` and
 * injecting the meta before `</head>`). They perform NO IO and NEVER import the
 * server module / models, so they are unit-testable in isolation and can be
 * called from the request path without pulling a heavy dependency graph.
 *
 * The IO layer (fetching the shell, the Oxy profile, and the hydrated post) lives
 * in `routes/webShell.routes.ts`, which is the only caller of these functions.
 */
import { OxyServices, getNormalizedUserHandle } from '@oxyhq/core';
import type { HydratedPost } from '@mention/shared-types';

/** Normalized OG payload injected into a shell for one profile / post URL. */
export interface OgData {
  title: string;
  description: string;
  /** Absolute image URL; omitted entirely when the entity has no image. */
  image?: string;
  url: string;
  /** OpenGraph object type (`profile` | `article`). */
  type: string;
}

/** Canonical web origin used for `og:url` (the apex the SPA is served from). */
const WEB_ORIGIN = (process.env.MENTION_WEB_ORIGIN || 'https://mention.earth').replace(/\/+$/, '');

/** Oxy API origin — bare-file-id avatars resolve to their public CDN URL through the SDK. */
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';

/**
 * A bare, unauthenticated OxyServices instance used ONLY as the canonical
 * `getFileDownloadUrl` chokepoint for building public CDN URLs from bare Oxy
 * file ids (never hardcode `cloud.oxy.so`). It is intentionally separate from the
 * service client in `utils/oxyHelpers` — that module transitively imports the
 * server entrypoint, which would defeat this module's isolation. URL building
 * needs no auth, so a plain client is both correct and test-safe.
 */
const cdnUrlClient = new OxyServices({ baseURL: OXY_API_URL });

/** Shape of the Oxy `/profiles/username/<handle>` payload we read for OG. */
export interface OxyProfileData {
  username?: string;
  name?: { displayName?: string };
  avatar?: string;
  bio?: string;
  description?: string;
}

/**
 * Escape a string for safe interpolation into HTML attribute / text contexts.
 * Handles the minimum dangerous set (`& < > "`), matching the retired worker.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the OG/Twitter `<meta>` block for injection into `<head>`. Every dynamic
 * value is HTML-escaped. `og:image`/`twitter:image` are emitted only when an
 * image is present (a preview card without an image is still valid).
 */
export function buildOgMetaHtml(og: OgData): string {
  const title = escapeHtml(og.title);
  const description = escapeHtml(og.description);
  const url = escapeHtml(og.url);
  const type = escapeHtml(og.type);

  let html =
    `<meta property="og:type" content="${type}">` +
    `<meta property="og:site_name" content="Mention">` +
    `<meta property="og:url" content="${url}">` +
    `<meta property="og:title" content="${title}">` +
    `<meta property="og:description" content="${description}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${title}">` +
    `<meta name="twitter:description" content="${description}">` +
    `<meta name="description" content="${description}">`;

  if (og.image) {
    const image = escapeHtml(og.image);
    html +=
      `<meta property="og:image" content="${image}">` +
      `<meta name="twitter:image" content="${image}">`;
  }

  return html;
}

const TITLE_RE = /<title\b[^>]*>[\s\S]*?<\/title>/i;
const HEAD_CLOSE_RE = /<\/head>/i;

/**
 * Splice OG data into a static SPA shell: replace the existing `<title>` and
 * inject the OG/Twitter meta block immediately before `</head>`. When `og` is
 * null the shell is returned verbatim (browsers still boot the SPA; crawlers
 * simply see no rich preview). Function replacements are used so a `$` in the
 * injected content is never interpreted as a `String.replace` back-reference.
 */
export function renderShellWithOg(shell: string, og: OgData | null): string {
  if (!og) return shell;

  const meta = buildOgMetaHtml(og);
  const titleTag = `<title>${escapeHtml(og.title)}</title>`;

  let html = shell;
  html = TITLE_RE.test(html) ? html.replace(TITLE_RE, () => titleTag) : html;
  html = HEAD_CLOSE_RE.test(html)
    ? html.replace(HEAD_CLOSE_RE, () => `${meta}</head>`)
    : meta + html;

  return html;
}

/**
 * Map an Oxy profile payload (`/profiles/username/<handle>`) into OG data. Works
 * for local and federated handles — both resolve through the Oxy API. Returns
 * null when the handle is unknown (no `username`).
 */
export function mapProfileOg(data: OxyProfileData | null | undefined): OgData | null {
  if (!data?.username) return null;

  const username = data.username;
  const displayName = data.name?.displayName;
  const avatar = data.avatar;

  let image: string | undefined;
  if (typeof avatar === 'string' && avatar.length > 0) {
    // Federated avatars are absolute URLs; local avatars are bare Oxy file ids
    // resolved to their public CDN URL through the canonical SDK helper.
    image = /^https?:\/\//.test(avatar) ? avatar : cdnUrlClient.getFileDownloadUrl(avatar, 'thumb');
  }

  return {
    title: displayName ? `${displayName} (@${username}) on Mention` : `@${username} on Mention`,
    description: (data.bio || data.description || '').trim(),
    image,
    url: `${WEB_ORIGIN}/@${username}`,
    type: 'profile',
  };
}

/**
 * Map a hydrated post into OG data. Media / poster / link-preview URLs are
 * already absolute (resolved server-side during hydration). The author avatar is
 * a canonical Oxy `User` shape: a federated absolute URL or a bare Oxy file id
 * resolved to its public CDN URL through the SDK — never a pre-resolved
 * `avatarUrl` shim.
 */
export function mapPostOg(post: HydratedPost, id: string): OgData {
  const user = post.user;
  const handle = getNormalizedUserHandle(user);
  const author = user.name?.displayName?.trim() || (handle ? `@${handle}` : 'Someone');
  const media = post.content?.media?.[0];

  let avatarImage: string | undefined;
  const avatar = user.avatar;
  if (typeof avatar === 'string' && avatar.length > 0) {
    avatarImage = /^https?:\/\//.test(avatar) ? avatar : cdnUrlClient.getFileDownloadUrl(avatar, 'thumb');
  }

  const image =
    media?.url || media?.thumbUrl || media?.posterUrl || post.linkPreview?.image || avatarImage || undefined;

  return {
    title: `${author} on Mention`,
    description: (post.content?.text || '').trim().slice(0, 200),
    image,
    url: `${WEB_ORIGIN}/p/${id}`,
    type: 'article',
  };
}
