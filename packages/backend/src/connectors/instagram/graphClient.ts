import { config, getMetaGraphAccessToken } from '../../config';
import { logger } from '../../utils/logger';
import { fetchUpstreamSingleHop } from '../../utils/safeUpstreamFetch';
import { readBoundedResponseBody } from '../shared/httpBody';
import { GRAPH_API_HOST, isInstagramGraphEnabled, isValidInstagramUsername } from './constants';
import {
  acquireCallBudget,
  recordThrottle,
  recordTokenInvalid,
  recordUsage,
  type GraphCallKind,
} from './usageBudget';

/**
 * The Meta Graph API client — Instagram Business Discovery, and nothing else.
 *
 *   GET https://graph.facebook.com/<version>/<IG_BUSINESS_ACCOUNT_ID>
 *       ?fields=business_discovery.username(<u>){<profile>,media.limit(N).after(C){<media>}}
 *
 * Only Business and Creator accounts are discoverable; a personal or unknown
 * account answers 400 code 110 / subcode 2207013. Every request:
 *
 *  - goes through the SSRF-guarded, IP-pinned single-hop fetch every other
 *    connector uses, with a header and body deadline and a byte cap;
 *  - carries the token in the `Authorization` header, never the URL, so no URL
 *    this module builds is a secret — and still no URL or token is ever logged;
 *  - is gated by the shared usage budget BEFORE it is sent, and feeds the
 *    response's `x-app-usage` back into it.
 */

/** Time-to-first-byte + body deadline. A carousel-heavy page is large, not slow. */
const GRAPH_TIMEOUT_MS = 20_000;

/** A page of 25 media with 20-child carousels and long signed CDN URLs fits well under this. */
const MAX_GRAPH_RESPONSE_BYTES = 8 * 1024 * 1024;

const USER_AGENT = 'Mention/instagram-connector (+https://mention.earth)';

/** A Graph `after` cursor: opaque base64url-ish. Bounded so it cannot smuggle syntax. */
const CURSOR_RE = /^[A-Za-z0-9_=-]{1,1024}$/;

const PROFILE_FIELDS =
  'id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count';

const MEDIA_FIELDS =
  'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,' +
  'like_count,comments_count,children{media_type,media_url,thumbnail_url}';

export type InstagramGraphErrorKind =
  | 'disabled'
  | 'invalid_request'
  | 'budget'
  | 'not_business'
  | 'throttled'
  | 'token_invalid'
  | 'api'
  | 'transport'
  | 'bad_response';

/**
 * A failed Graph call, classified. `message` never contains the request URL, the
 * token, or the upstream body — only Meta's short error `message` and codes.
 */
export class InstagramGraphError extends Error {
  readonly kind: InstagramGraphErrorKind;
  readonly status?: number;
  readonly code?: number;
  readonly subcode?: number;

  constructor(
    kind: InstagramGraphErrorKind,
    message: string,
    detail: { status?: number; code?: number; subcode?: number } = {},
  ) {
    super(message);
    this.name = 'InstagramGraphError';
    this.kind = kind;
    this.status = detail.status;
    this.code = detail.code;
    this.subcode = detail.subcode;
  }
}

export interface GraphChildMedia {
  id?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
}

export interface GraphMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  children?: { data?: GraphChildMedia[] };
}

export interface GraphMediaPage {
  data: GraphMedia[];
  after?: string;
}

/** The `business_discovery` object: profile fields plus (optionally) one media page. */
export interface GraphBusinessProfile {
  id: string;
  username: string;
  name?: string;
  biography?: string;
  profile_picture_url?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  media?: GraphMediaPage;
}

/** Codes Meta uses for "slow down" (app, user, page and custom-rate limits). */
const THROTTLE_CODES = new Set([4, 17, 32, 613]);

/** Subcode for "the username is not a discoverable Business/Creator account". */
const NOT_BUSINESS_SUBCODE = 2207013;

const TOKEN_INVALID_CODE = 190;

/** One loud log per process for a rejected token, not one per call. */
let tokenInvalidLogged = false;

/** Test seam. */
export function resetGraphClientForTests(): void {
  tokenInvalidLogged = false;
}

interface GraphErrorBody {
  error?: { message?: unknown; code?: unknown; error_subcode?: unknown; type?: unknown };
}

/** Classify a Graph error body. Exported for tests. */
export function classifyGraphError(status: number, body: unknown): InstagramGraphError {
  const error =
    (body && typeof body === 'object' ? (body as GraphErrorBody).error : undefined) ?? {};
  const code = typeof error.code === 'number' ? error.code : undefined;
  const subcode = typeof error.error_subcode === 'number' ? error.error_subcode : undefined;
  // Meta's message is a short sentence about the request; it carries no token.
  const upstreamMessage =
    typeof error.message === 'string' ? error.message.slice(0, 200) : `HTTP ${status}`;
  const detail = { status, code, subcode };

  if (subcode === NOT_BUSINESS_SUBCODE) {
    return new InstagramGraphError(
      'not_business',
      'Not a discoverable Instagram Business/Creator account',
      detail,
    );
  }
  if ((code !== undefined && THROTTLE_CODES.has(code)) || status === 429) {
    return new InstagramGraphError('throttled', `Graph API throttled: ${upstreamMessage}`, detail);
  }
  if (code === TOKEN_INVALID_CODE) {
    return new InstagramGraphError(
      'token_invalid',
      `Graph API token rejected: ${upstreamMessage}`,
      detail,
    );
  }
  return new InstagramGraphError('api', `Graph API error: ${upstreamMessage}`, detail);
}

/** Build the `fields` expression. Exported for tests. */
export function buildBusinessDiscoveryFields(
  username: string,
  media?: { limit: number; after?: string },
): string {
  const mediaEdge = media
    ? `,media.limit(${Math.max(1, Math.min(50, Math.trunc(media.limit)))})${media.after ? `.after(${media.after})` : ''}{${MEDIA_FIELDS}}`
    : '';
  return `business_discovery.username(${username}){${PROFILE_FIELDS}${mediaEdge}}`;
}

function asGraphProfile(raw: unknown, requestedUsername: string): GraphBusinessProfile {
  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  const discovery = root?.business_discovery;
  if (!discovery || typeof discovery !== 'object') {
    throw new InstagramGraphError(
      'bad_response',
      'Graph response carried no business_discovery object',
    );
  }
  const record = discovery as Record<string, unknown>;
  if (typeof record.id !== 'string' || !/^\d{1,32}$/.test(record.id)) {
    throw new InstagramGraphError('bad_response', 'Graph business_discovery carried no usable id');
  }
  const username = typeof record.username === 'string' ? record.username : requestedUsername;
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

  let media: GraphMediaPage | undefined;
  const rawMedia = record.media;
  if (rawMedia && typeof rawMedia === 'object') {
    const mediaRecord = rawMedia as { data?: unknown; paging?: { cursors?: { after?: unknown } } };
    const data = Array.isArray(mediaRecord.data)
      ? mediaRecord.data.filter(
          (item): item is GraphMedia =>
            Boolean(item) && typeof (item as GraphMedia).id === 'string',
        )
      : [];
    const after = mediaRecord.paging?.cursors?.after;
    media = {
      data,
      // A nested Business Discovery edge carries `cursors.after` but no `next`
      // (measured on the real @plex/@zuck responses), so the cursor alone is
      // the continuation; the caller stops on a short or empty page.
      after: typeof after === 'string' && CURSOR_RE.test(after) ? after : undefined,
    };
  }

  return {
    id: record.id,
    username,
    name: str(record.name),
    biography: str(record.biography),
    profile_picture_url: str(record.profile_picture_url),
    followers_count: num(record.followers_count),
    follows_count: num(record.follows_count),
    media_count: num(record.media_count),
    media,
  };
}

/**
 * Business Discovery for `username`: its profile and, when `media` is given,
 * one page of its media, newest first.
 *
 * @throws {InstagramGraphError} — never a raw transport error.
 */
export async function fetchBusinessDiscovery(
  username: string,
  options: { kind: GraphCallKind; media?: { limit: number; after?: string } },
): Promise<GraphBusinessProfile> {
  const token = getMetaGraphAccessToken();
  const accountId = config.instagramGraph.businessAccountId;
  if (!isInstagramGraphEnabled() || !token || !accountId) {
    throw new InstagramGraphError('disabled', 'Instagram Graph connector is not configured');
  }
  if (!isValidInstagramUsername(username)) {
    throw new InstagramGraphError('invalid_request', 'Not an Instagram username');
  }
  if (options.media?.after !== undefined && !CURSOR_RE.test(options.media.after)) {
    throw new InstagramGraphError('invalid_request', 'Not a Graph paging cursor');
  }

  // Takes a call token atomically, BEFORE the call: the budget is spent by
  // sending, not by the answer arriving.
  const refusal = await acquireCallBudget(options.kind);
  if (refusal) {
    const kind = refusal === 'usage' || refusal === 'tokens' ? 'budget' : refusal;
    throw new InstagramGraphError(kind, `Graph call withheld (${refusal})`);
  }

  const fields = buildBusinessDiscoveryFields(username, options.media);
  const url = `https://${GRAPH_API_HOST}/${config.instagramGraph.apiVersion}/${accountId}?fields=${encodeURIComponent(fields)}`;

  let status: number;
  let headers: Record<string, string | string[] | undefined>;
  let bodyText: string;
  try {
    const result = await fetchUpstreamSingleHop(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      headersTimeoutMs: GRAPH_TIMEOUT_MS,
    });
    status = result.status;
    headers = result.headers;
    bodyText = Buffer.from(
      await readBoundedResponseBody(result.response, MAX_GRAPH_RESPONSE_BYTES),
    ).toString('utf8');
  } catch (err) {
    // The transport error names the host at most; it is summarised, not echoed.
    const name = err instanceof Error ? err.name : 'Error';
    throw new InstagramGraphError('transport', `Graph API request failed (${name})`);
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = undefined;
  }

  const succeeded = status >= 200 && status < 300;
  await recordUsage(headers['x-app-usage'], succeeded).catch(() => undefined);

  if (!succeeded) {
    const error = classifyGraphError(status, body);
    if (error.kind === 'throttled') {
      const until = await recordThrottle().catch(() => 0);
      logger.warn('[instagram] Graph API throttled; backing off', {
        code: error.code,
        until: until ? new Date(until).toISOString() : undefined,
      });
    } else if (error.kind === 'token_invalid') {
      await recordTokenInvalid().catch(() => undefined);
      if (!tokenInvalidLogged) {
        tokenInvalidLogged = true;
        // Loud, once: nothing Instagram imports again until an operator rotates
        // META_GRAPH_ACCESS_TOKEN. The token itself is never logged.
        logger.error(
          '[instagram] META_GRAPH_ACCESS_TOKEN was rejected by the Graph API (code 190); Instagram sync is paused until it is replaced',
          {
            subcode: error.subcode,
          },
        );
      }
    }
    throw error;
  }

  if (body === undefined) {
    throw new InstagramGraphError('bad_response', 'Graph API returned invalid JSON', { status });
  }
  return asGraphProfile(body, username);
}
