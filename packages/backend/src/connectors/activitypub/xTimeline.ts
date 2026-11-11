import { readResponseBody, safeFetch } from '@oxy.so/core/server';
import { z } from 'zod';
import { logger } from '../../utils/logger';
import { USER_AGENT } from './constants';
import { sleep } from '../../utils/sleep';

/**
 * AN X ACCOUNT'S TIMELINE: WHICH TWEETS EXIST, FROM FXTWITTER; THE TWEETS, FROM BIRD.MAKEUP.
 *
 * An X account reaches Mention as a bird.makeup actor. bird.makeup serves any
 * tweet by id (`/users/<handle>/statuses/<tweet id>`, the same Note it delivers),
 * but its outbox is a bare `{"type":"Collection"}` and it crawls each account
 * rarely, one timeline page at a time, so an account that tweets a lot loses
 * tweets between its crawls. mastox.eu, the keyless bridge, stalls for hours.
 *
 * FxTwitter's public API (`api.fxtwitter.com/2/profile/<handle>/statuses`,
 * no key) lists an account's timeline live: its own tweets and its retweets, by
 * tweet id, newest first, paged with a cursor. This module only DISCOVERS what
 * is there. Nothing is ever built from FxTwitter's JSON: a tweet is fetched from
 * bird.makeup by its id and imported through the outbox's own item path, the
 * same signed, validated, deduplicated road every other outbox takes, so its
 * body, media, quote, mentions and upstream key (`x:<tweet id>`) are exactly the
 * bridge's. A retweet becomes a boost of the original, under the minted activity
 * id {@link repostActivityId}: X gives a retweet no id of its own, and one
 * account retweets one tweet once.
 *
 * FxTwitter answers 404 for a live account on a good share of calls (its own
 * upstream flakes), so a page is asked for a few times before a run gives up;
 * a run that gets nothing is retried by the next one. Its documented limit is
 * 1,000 requests a minute per IP; a run asks one or two pages per account.
 */

const FXTWITTER_API = 'https://api.fxtwitter.com';

/** The bridge whose actors and statuses an X account is held under. */
const X_BRIDGE_ORIGIN = 'https://bird.makeup';

const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_ID = /^\d{1,20}$/;

/** Attempts per page: one 404 from FxTwitter is not evidence the account is gone. */
const PAGE_ATTEMPTS = 5;
const RETRY_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export function bridgeActorUri(handle: string): string {
  return `${X_BRIDGE_ORIGIN}/users/${handle.toLowerCase()}`;
}

export function bridgeStatusUri(handle: string, tweetId: string): string {
  return `${bridgeActorUri(handle)}/statuses/${tweetId}`;
}

/** A retweet's minted activity id: stable per (account, original), and never fetchable. */
export function repostActivityId(handle: string, originalTweetId: string): string {
  return `tag:mention.earth,2026:x-history/${handle.toLowerCase()}/repost/${originalTweetId}`;
}

/** The X handle of a bird.makeup actor, or undefined for any other actor. */
export function xTimelineHandle(actorUri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(actorUri);
  } catch {
    return undefined;
  }
  if (url.origin !== X_BRIDGE_ORIGIN || url.search || url.hash) return undefined;
  const [users, handle, ...rest] = url.pathname.split('/').filter(Boolean);
  return users === 'users' && rest.length === 0 && handle && X_HANDLE.test(handle)
    ? handle.toLowerCase()
    : undefined;
}

/** The first timeline page of `handle`, or the page `cursor` points at. */
export function xTimelinePageUrl(handle: string, cursor?: string): string {
  const url = new URL(`${FXTWITTER_API}/2/profile/${handle.toLowerCase()}/statuses`);
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.href;
}

/** Whether `url` is a timeline page of `handle` (a stored backfill cursor). */
export function isXTimelinePageUrl(url: string, handle: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === FXTWITTER_API &&
      parsed.pathname === `/2/profile/${handle.toLowerCase()}/statuses` &&
      [...parsed.searchParams.keys()].every((key) => key === 'cursor')
    );
  } catch {
    return false;
  }
}

/**
 * One timeline item: the account's own tweet (`reply` when it answers a tweet,
 * as a self-thread's continuation does), or its retweet of `author`'s tweet `id`.
 */
export type XTimelineEntry =
  | { kind: 'post'; id: string; reply: boolean }
  | { kind: 'repost'; id: string; author: string };

export interface XTimelinePage {
  /** Newest first, as the timeline lists them. */
  entries: XTimelineEntry[];
  /** The next (older) page, when there is one. */
  next?: string;
}

const screenName = z.object({ screen_name: z.string().regex(X_HANDLE) }).loose();

const timelineSchema = z
  .object({
    code: z.literal(200),
    results: z.array(
      z
        .object({
          id: z.string().regex(TWEET_ID),
          author: screenName,
          reposted_by: screenName.nullish(),
          replying_to: z.unknown().optional(),
        })
        .loose(),
    ),
    cursor: z
      .object({ bottom: z.string().max(512).nullish() })
      .loose()
      .nullish(),
  })
  .loose();

/**
 * The timeline items of `handle` on one page, or null when FxTwitter did not
 * list them after {@link PAGE_ATTEMPTS} tries. An item that is neither the
 * account's own tweet nor its retweet is left out. Never throws.
 */
export async function fetchXTimelinePage(
  handle: string,
  pageUrl: string = xTimelinePageUrl(handle),
  options: { retryDelayMs?: number } = {},
): Promise<XTimelinePage | null> {
  const account = handle.toLowerCase();
  for (let attempt = 1; attempt <= PAGE_ATTEMPTS; attempt++) {
    const parsed = timelineSchema.safeParse(await getJson(pageUrl));
    if (parsed.success) {
      const entries: XTimelineEntry[] = [];
      for (const item of parsed.data.results) {
        const author = item.author.screen_name.toLowerCase();
        const reposter = item.reposted_by?.screen_name.toLowerCase();
        if (reposter === account) entries.push({ kind: 'repost', id: item.id, author });
        else if (!reposter && author === account)
          entries.push({ kind: 'post', id: item.id, reply: item.replying_to != null });
      }
      const cursor = parsed.data.cursor?.bottom;
      return {
        entries,
        ...(cursor && parsed.data.results.length > 0
          ? { next: xTimelinePageUrl(account, cursor) }
          : {}),
      };
    }
    if (attempt < PAGE_ATTEMPTS) await sleep(options.retryDelayMs ?? RETRY_DELAY_MS);
  }
  logger.info('[FedSync] X timeline not listed', { attempts: PAGE_ATTEMPTS });
  return null;
}

/** One bounded, SSRF-safe GET of a JSON document; undefined on any failure. */
async function getJson(url: string): Promise<unknown> {
  try {
    const { response, status } = await safeFetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headersTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    // FxTwitter's flaky 404 carries `{"code":404,"results":[]}`; it fails the schema.
    if (status < 200 || status >= 300) {
      response.destroy();
      return undefined;
    }
    const body = await readResponseBody(response, {
      maxBytes: MAX_JSON_BYTES,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return body.kind === 'ok' ? JSON.parse(body.body.toString('utf8')) : undefined;
  } catch {
    return undefined;
  }
}
