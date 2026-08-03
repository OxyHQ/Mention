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
import type { AccountKind } from '@oxyhq/core';
import type { HydratedPost } from '@mention/shared-types';
import { config } from '../config';

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
const WEB_ORIGIN = config.web.origin;

/** Oxy API origin — bare-file-id avatars resolve to their public CDN URL through the SDK. */
const OXY_API_URL = config.oxyApiUrl;

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
  /**
   * The Oxy account classification. Only `channel` is acted on here, and only to
   * decide which canonical URL the profile lives at — see
   * {@link canonicalProfilePath}.
   */
  kind?: AccountKind;
}

/**
 * Where a profile canonically lives on the web: `/c/<handle>` for a channel
 * account, `/@<handle>` for everyone else.
 *
 * ONE definition, so the OG `og:url` a crawler reads and the redirect a browser
 * follows cannot disagree — a canonical URL that redirects is a canonical URL
 * that is wrong.
 */
export function canonicalProfilePath(profile: OxyProfileData): string {
  const username = profile.username ?? '';
  return profile.kind === 'channel'
    ? `/c/${encodeURIComponent(username)}`
    : `/@${encodeURIComponent(username)}`;
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
 * image is present (a preview card without an image is still valid), and the
 * Twitter card type follows: `summary_large_image` promises an image, so a card
 * with no image must declare the plain `summary` instead.
 */
export function buildOgMetaHtml(og: OgData): string {
  const title = escapeHtml(og.title);
  const description = escapeHtml(og.description);
  const url = escapeHtml(og.url);
  const type = escapeHtml(og.type);
  const card = og.image ? 'summary_large_image' : 'summary';

  let html =
    `<meta property="og:type" content="${type}">` +
    `<meta property="og:site_name" content="Mention">` +
    `<meta property="og:url" content="${url}">` +
    `<meta property="og:title" content="${title}">` +
    `<meta property="og:description" content="${description}">` +
    `<meta name="twitter:card" content="${card}">` +
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
 * Insert an HTML snippet immediately before `</head>` (or prepend it when the
 * shell somehow lacks a head). Used for STATIC `<head>` hints (e.g. `preconnect`)
 * that are independent of the per-request OG block. A function replacement is used
 * so a `$` in the snippet is never treated as a `String.replace` back-reference.
 */
export function injectHeadHtml(shell: string, snippet: string): string {
  if (!snippet) return shell;
  return HEAD_CLOSE_RE.test(shell)
    ? shell.replace(HEAD_CLOSE_RE, () => `${snippet}</head>`)
    : snippet + shell;
}

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
    url: `${WEB_ORIGIN}${canonicalProfilePath(data)}`,
    type: 'profile',
  };
}

/**
 * The safety verdict a post's OG card is rendered under. Required rather than
 * optional so no future caller can render a card without having decided: an
 * unfurler has no viewer, so there is no per-user setting to consult and no way for
 * the people in that chat to opt in.
 */
export interface PostOgSafety {
  /**
   * Whether the post may only be shown behind a warning (sensitive/NSFW, or a
   * federated content warning). Computed by the caller from the RAW post row, which
   * carries every signal — see `mtn/feed/feedSafety.requiresContentWarning`.
   */
  requiresWarning: boolean;
  /** The federated content-warning label, when the post carries one. */
  contentWarning?: string;
}

/**
 * Description used for a gated post that carries no content-warning label of its
 * own. Deliberately says nothing about the post beyond the fact that it is gated.
 */
const GATED_POST_DESCRIPTION = 'This post is marked sensitive. Open it on Mention to view it.';

/**
 * Map a hydrated post into OG data. Media / poster / link-preview URLs are
 * already absolute (resolved server-side during hydration). The author avatar is
 * a canonical Oxy `User` shape: a federated absolute URL or a bare Oxy file id
 * resolved to its public CDN URL through the SDK — never a pre-resolved
 * `avatarUrl` shim.
 *
 * A post that {@link PostOgSafety.requiresWarning} gets NO image and none of its
 * body text. An unfurl renders at full size in Slack / Discord / iMessage for
 * everyone in the conversation, with no content warning and nobody having opted in —
 * so emitting the media there defeats the in-app warning completely, for people who
 * never asked to see it. Title and URL still go out: attributing a post to its
 * author and linking to it reveals nothing the warning was protecting, and a card
 * with no metadata at all would just look broken. The description carries the
 * author's own content warning when there is one (the fediverse convention — it is
 * written precisely to be read INSTEAD of the body), else a neutral notice.
 */
export function mapPostOg(post: HydratedPost, id: string, safety: PostOgSafety): OgData {
  const user = post.user;
  const handle = getNormalizedUserHandle(user);
  const author = user.name?.displayName?.trim() || (handle ? `@${handle}` : 'Someone');

  if (safety.requiresWarning) {
    const warning = safety.contentWarning?.trim();
    return {
      title: `${author} on Mention`,
      description: (warning || GATED_POST_DESCRIPTION).slice(0, 200),
      url: `${WEB_ORIGIN}/p/${id}`,
      type: 'article',
    };
  }

  const media = post.content?.media?.[0];

  let avatarImage: string | undefined;
  const avatar = user.avatar;
  if (typeof avatar === 'string' && avatar.length > 0) {
    avatarImage = /^https?:\/\//.test(avatar) ? avatar : cdnUrlClient.getFileDownloadUrl(avatar, 'thumb');
  }

  const image =
    media?.url || media?.thumbUrl || media?.posterUrl || post.linkPreviews?.[0]?.image || avatarImage || undefined;

  // A boost has an intentionally empty body — its renderable text lives on the
  // boosted original (embedded at maxDepth:1). Fall back to the original's text so
  // a boost's OG/preview description is not blank.
  const ownText = (post.content?.text || '').trim();
  const description = (ownText || (post.originalPost?.content?.text || '').trim()).slice(0, 200);

  return {
    title: `${author} on Mention`,
    description,
    image,
    url: `${WEB_ORIGIN}/p/${id}`,
    type: 'article',
  };
}
